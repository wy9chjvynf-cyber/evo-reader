import { beforeEach, describe, expect, it, vi } from "vitest";

// pdfjs-dist needs real binary parsing + a worker, none of which is available
// (or desirable) in a unit test — fake it with a small in-memory "document"
// whose page texts are controlled per test via this hoisted-safe box.
const pdfMock = vi.hoisted(() => ({ pages: [] as string[] }));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: pdfMock.pages.length,
      getPage: async (pageNumber: number) => ({
        getTextContent: async () => ({ items: [{ str: pdfMock.pages[pageNumber - 1] }] }),
        cleanup: () => {},
      }),
      cleanup: async () => {},
    }),
  }),
}));
vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "mock-worker.js" }));

const { clearAllBooks, getBook, getChunkRange, putBook, putChunksBatch, putFileBlob } = await import("../db");
const { runImport, runResume } = await import("../bookImport");

function makeTextFile(name: string, content: string): File {
  return new File([content], name, { type: "text/plain" });
}

function makePdfFile(name = "libro.pdf"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
}

describe("bookImport", () => {
  beforeEach(async () => {
    await clearAllBooks();
    pdfMock.pages = [];
  });

  it("rejects unsupported formats without creating a book", async () => {
    await expect(runImport(makeTextFile("libro.epub", "whatever"))).rejects.toThrow(/no soportado/i);
  });

  it("imports a txt file in batches, reporting progress, and marks it done", async () => {
    const text = "Frase uno. Frase dos. Frase tres. ".repeat(80);
    const percents: (number | null)[] = [];

    const book = await runImport(makeTextFile("libro.txt", text), {
      onProgress: (_b, p) => percents.push(p.percent),
    });

    expect(book.importStatus).toBe("done");
    expect(book.totalChunks).toBeGreaterThan(0);
    expect(book.importedUntil).toBe(book.totalChunks);
    expect(percents.at(-1)).toBe(100);

    const chunks = await getChunkRange(book.id, 0, book.totalChunks - 1);
    expect(chunks).toHaveLength(book.totalChunks);
    // contiguous, no gaps or duplicates
    const indices = chunks.map((c) => c.index).sort((a, b) => a - b);
    expect(indices).toEqual([...Array(book.totalChunks).keys()]);
  });

  it("imports a pdf page by page, persisting after every page (not one giant blob)", async () => {
    pdfMock.pages = ["Página uno con texto narrable.", "Página dos con más texto.", "Página tres, la última."];
    const pagesSeen: number[] = [];

    const book = await runImport(makePdfFile(), {
      onProgress: (_b, p) => pagesSeen.push(p.page),
    });

    expect(book.importStatus).toBe("done");
    expect(book.totalPages).toBe(3);
    expect(pagesSeen).toEqual([1, 2, 3]); // one commit per page, in order

    const finalBook = await getBook(book.id);
    expect(finalBook?.importedUntil).toBe(3);
    expect(finalBook?.totalChunks).toBe(3); // one short sentence per page here
  });

  it("keeps only one active book: a new import clears the previous one's chunks", async () => {
    pdfMock.pages = ["Primero."];
    const first = await runImport(makePdfFile("uno.pdf"));

    pdfMock.pages = ["Segundo."];
    const second = await runImport(makePdfFile("dos.pdf"));

    expect(await getBook(first.id)).toBeUndefined();
    expect((await getChunkRange(first.id, 0, 10)).length).toBe(0);
    expect((await getBook(second.id))?.importStatus).toBe("done");
  });

  it("resume continues a pdf import from the interruption point with no duplicated or missing chunks", async () => {
    pdfMock.pages = ["Uno.", "Dos.", "Tres.", "Cuatro.", "Cinco."];
    const bookId = "resume-test";
    const now = Date.now();

    // Simulate an import that committed pages 1-2 and then got interrupted.
    await putBook({
      id: bookId,
      title: "Resume test",
      format: "pdf",
      size: 10,
      totalPages: 5,
      totalChunks: 2,
      currentChunk: 0,
      importStatus: "importing",
      importedUntil: 2,
      rate: 1,
      voiceURI: null,
      createdAt: now,
      updatedAt: now,
    });
    await putChunksBatch([
      { bookId, index: 0, sectionIndex: 0, sourcePage: 1, text: "Uno." },
      { bookId, index: 1, sectionIndex: 1, sourcePage: 2, text: "Dos." },
    ]);
    await putFileBlob(bookId, new Blob(["fake-pdf-bytes"]));

    const interrupted = (await getBook(bookId))!;
    const resumedPages: number[] = [];
    const finished = await runResume(interrupted, { onProgress: (_b, p) => resumedPages.push(p.page) });

    expect(resumedPages).toEqual([3, 4, 5]); // only the remaining pages, not 1-2 again
    expect(finished.importStatus).toBe("done");
    expect(finished.totalChunks).toBe(5);

    const chunks = await getChunkRange(bookId, 0, 10);
    const indices = chunks.map((c) => c.index).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3, 4]);
    expect(chunks.sort((a, b) => a.index - b.index).map((c) => c.text)).toEqual([
      "Uno.",
      "Dos.",
      "Tres.",
      "Cuatro.",
      "Cinco.",
    ]);
  });

  it("resume fails gracefully (and marks the book errored) when the original file is gone", async () => {
    const bookId = "no-blob";
    const now = Date.now();
    await putBook({
      id: bookId,
      title: "No blob",
      format: "pdf",
      size: 10,
      totalPages: 5,
      totalChunks: 1,
      currentChunk: 0,
      importStatus: "importing",
      importedUntil: 1,
      rate: 1,
      voiceURI: null,
      createdAt: now,
      updatedAt: now,
    });
    // No putFileBlob() call — the original bytes were never persisted or were evicted.

    const interrupted = (await getBook(bookId))!;
    let errorMessage: string | undefined;
    const result = await runResume(interrupted, { onError: (m) => (errorMessage = m) });

    expect(result.importStatus).toBe("error");
    expect(errorMessage).toMatch(/no está disponible/i);
  });

  it("resume on a non-pdf book fails without crashing (txt/docx aren't resumable mid-way)", async () => {
    const bookId = "txt-interrupted";
    const now = Date.now();
    await putBook({
      id: bookId,
      title: "Interrupted txt",
      format: "txt",
      size: 10,
      totalPages: null,
      totalChunks: 200,
      currentChunk: 0,
      importStatus: "importing",
      importedUntil: 200,
      rate: 1,
      voiceURI: null,
      createdAt: now,
      updatedAt: now,
    });

    const interrupted = (await getBook(bookId))!;
    const result = await runResume(interrupted);
    expect(result.importStatus).toBe("error");
  });
});
