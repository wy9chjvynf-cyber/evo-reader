// PDF/TXT/MD only — no DOMParser needed, so this runs in the default 'node'
// environment, where Blob round-trips correctly through fake-indexeddb (see
// docxImport.test.ts / epubImport.test.ts for why DOCX/EPUB, which need
// jsdom for DOMParser, are tested separately).
import { beforeEach, describe, expect, it, vi } from "vitest";

const pdfMock = vi.hoisted(() => ({ pages: [] as string[] }));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: pdfMock.pages.length,
      getPage: async (pageNumber: number) => ({
        getTextContent: async () => ({
          // One "line" per newline-separated fragment, each ending the line
          // (hasEOL), matching how pdfImport.ts reconstructs lines for
          // heading detection.
          items: pdfMock.pages[pageNumber - 1].split("\n").map((str) => ({ str, hasEOL: true })),
        }),
        cleanup: () => {},
        getViewport: () => ({ width: 100, height: 100 }),
        render: () => ({ promise: Promise.resolve() }),
      }),
      cleanup: async () => {},
    }),
  }),
}));
vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "mock-worker.js" }));

const { clearAllBooks, getBook, getChunkRange, getFileBlob, getSections, putBook, putChunksBatch, putFileBlob, putSection } =
  await import("../db");
const { runImport, runResume } = await import("../bookImport");

function makeTextFile(name: string, content: string): File {
  return new File([content], name, { type: "text/plain" });
}

function makePdfFile(name = "libro.pdf"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
}

describe("bookImport — txt/md", () => {
  beforeEach(async () => {
    await clearAllBooks();
  });

  it("rejects unsupported formats without creating a book", async () => {
    await expect(runImport(makeTextFile("libro.epub2", "whatever"))).rejects.toThrow(/no soportado/i);
  });

  it("imports a txt file in batches, reporting progress, and marks it done", async () => {
    const text = "Frase uno. Frase dos. Frase tres. ".repeat(80);
    const percents: (number | null)[] = [];

    const book = await runImport(makeTextFile("libro.txt", text), {
      onProgress: (_b, p) => percents.push(p.percent),
    });

    expect(book.importStatus).toBe("done");
    expect(book.totalChunks).toBeGreaterThan(0);
    expect(percents.at(-1)).toBe(100);

    const chunks = await getChunkRange(book.id, 0, book.totalChunks - 1);
    expect(chunks).toHaveLength(book.totalChunks);
    expect(chunks.map((c) => c.index)).toEqual([...Array(book.totalChunks).keys()]);
  });

  it("detects chapters in a chapter-marked txt file", async () => {
    const text = ["TIERRA", "", "CAPÍTULO 1", "", "Texto del capítulo uno.", "", "CAPÍTULO 2", "", "Texto del capítulo dos."].join("\n");
    const book = await runImport(makeTextFile("libro.txt", text));
    const sections = await getSections(book.id);
    expect(sections.map((s) => s.title)).toEqual([null, "Capítulo 1", "Capítulo 2"]);
  });

  it("detects markdown headings for a .md file", async () => {
    const text = "# TIERRA\n\nTexto.\n\n## Capítulo 1\n\nMás texto.";
    const book = await runImport(makeTextFile("libro.md", text));
    expect(book.format).toBe("md");
    const sections = await getSections(book.id);
    expect(sections.map((s) => s.title)).toEqual(["TIERRA", "Capítulo 1"]);
  });

  it("keeps only one active book: a new import clears the previous one's chunks and sections", async () => {
    const first = await runImport(makeTextFile("uno.txt", "Contenido del primer libro, con suficiente texto."));
    const second = await runImport(makeTextFile("dos.txt", "Contenido del segundo libro, con suficiente texto."));

    expect(await getBook(first.id)).toBeUndefined();
    expect((await getChunkRange(first.id, 0, 10)).length).toBe(0);
    expect((await getSections(first.id)).length).toBe(0);
    expect((await getBook(second.id))?.importStatus).toBe("done");
  });
});

describe("bookImport — pdf", () => {
  beforeEach(async () => {
    await clearAllBooks();
    pdfMock.pages = [];
  });

  it("imports a pdf page by page and deletes the file blob once done", async () => {
    pdfMock.pages = ["Página uno con texto narrable.", "Página dos con más texto.", "Página tres, la última."];
    const pagesSeen: number[] = [];

    const book = await runImport(makePdfFile(), { onProgress: (_b, p) => pagesSeen.push(p.page) });

    expect(book.importStatus).toBe("done");
    expect(book.totalPages).toBe(3);
    expect(pagesSeen).toEqual([1, 2, 3]);
    expect(await getFileBlob(book.id)).toBeUndefined(); // cleaned up once import completed
  });

  it("the file blob exists while importing and is gone once complete", async () => {
    pdfMock.pages = ["Texto de una sola página."];
    let sawBlobDuringImport = false;
    await runImport(makePdfFile(), {
      onProgress: async (b) => {
        if (!sawBlobDuringImport) sawBlobDuringImport = (await getFileBlob(b.id)) !== undefined;
      },
    });
    expect(sawBlobDuringImport).toBe(true);
  });

  it("detects a conservative chapter heading and excludes it from the narrated text", async () => {
    pdfMock.pages = ["CAPÍTULO 1\nEl relojero Tomás siguió reparando mecanismos antiguos.", "Más texto de la misma sección."];
    const book = await runImport(makePdfFile());

    const sections = await getSections(book.id);
    expect(sections.map((s) => s.title)).toEqual(["Capítulo 1"]);

    const chunks = await getChunkRange(book.id, 0, book.totalChunks - 1);
    for (const c of chunks) expect(c.text).not.toContain("CAPÍTULO");
  });

  it("falls back to a single section for a pdf with no chapter markers (no false positives)", async () => {
    pdfMock.pages = ["Texto normal de la página uno.", "Texto normal de la página dos.", "Texto normal de la página tres."];
    const book = await runImport(makePdfFile());
    const sections = await getSections(book.id);
    expect(sections).toHaveLength(1);
    expect(sections[0].title).toBeNull();
  });

  it("resume continues a pdf import from the interruption point with no duplicated chunks or sections", async () => {
    pdfMock.pages = ["CAPÍTULO 1\nUno.", "Dos.", "CAPÍTULO 2\nTres.", "Cuatro."];
    const bookId = "resume-test";
    const now = Date.now();

    // Simulate an import interrupted right after page 1 (chapter 1 opened, one chunk written).
    await putBook({
      id: bookId,
      title: "Resume test",
      author: null,
      language: null,
      format: "pdf",
      size: 10,
      totalPages: 4,
      totalSections: 1,
      totalChunks: 1,
      wordCount: 1,
      currentSection: 0,
      currentChunk: 0,
      importStatus: "importing",
      importStage: "extracting",
      importProgress: 25,
      importedUntil: 1,
      hasCover: false,
      rate: 1,
      voiceURI: null,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    });
    await putSection({ bookId, index: 0, title: "Capítulo 1", level: 1, sourceType: "page", sourceStart: 1, sourceEnd: 1, firstChunkIndex: 0, lastChunkIndex: null, wordCount: 0 });
    await putChunksBatch([{ bookId, index: 0, sectionIndex: 0, sourcePage: 1, text: "Uno." }]);
    await putFileBlob(bookId, new Blob(["fake-pdf-bytes"]));

    const interrupted = (await getBook(bookId))!;
    const resumedPages: number[] = [];
    const finished = await runResume(interrupted, { onProgress: (_b, p) => resumedPages.push(p.page) });

    expect(resumedPages).toEqual([2, 3, 4]);
    expect(finished.importStatus).toBe("done");
    expect(finished.totalChunks).toBe(4);

    const sections = await getSections(bookId);
    expect(sections.map((s) => s.title)).toEqual(["Capítulo 1", "Capítulo 2"]);
    expect(sections[0].firstChunkIndex).toBe(0);
    expect(sections[0].lastChunkIndex).toBe(1); // "Uno." (pre-seeded) + "Dos." (page 2, still chapter 1)
    expect(sections[1].firstChunkIndex).toBe(2);
    expect(sections[1].lastChunkIndex).toBe(3);

    const chunks = await getChunkRange(bookId, 0, 10);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(chunks.map((c) => c.text)).toEqual(["Uno.", "Dos.", "Tres.", "Cuatro."]);
    expect(await getFileBlob(bookId)).toBeUndefined();
  });

  it("resume fails gracefully (and marks the book errored) when the original file is gone", async () => {
    const bookId = "no-blob";
    const now = Date.now();
    await putBook({
      id: bookId,
      title: "No blob",
      author: null,
      language: null,
      format: "pdf",
      size: 10,
      totalPages: 5,
      totalSections: 1,
      totalChunks: 1,
      wordCount: 1,
      currentSection: 0,
      currentChunk: 0,
      importStatus: "importing",
      importStage: "extracting",
      importProgress: 20,
      importedUntil: 1,
      hasCover: false,
      rate: 1,
      voiceURI: null,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    });

    const interrupted = (await getBook(bookId))!;
    let errorMessage: string | undefined;
    const result = await runResume(interrupted, { onError: (m) => (errorMessage = m) });

    expect(result.importStatus).toBe("error");
    expect(errorMessage).toMatch(/no está disponible/i);
  });

  it("resume on a non-resumable format fails without crashing", async () => {
    const bookId = "txt-interrupted";
    const now = Date.now();
    await putBook({
      id: bookId,
      title: "Interrupted txt",
      author: null,
      language: null,
      format: "txt",
      size: 10,
      totalPages: null,
      totalSections: 3,
      totalChunks: 200,
      wordCount: 500,
      currentSection: 0,
      currentChunk: 0,
      importStatus: "importing",
      importStage: "persisting",
      importProgress: 60,
      importedUntil: 200,
      hasCover: false,
      rate: 1,
      voiceURI: null,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
    });

    const interrupted = (await getBook(bookId))!;
    const result = await runResume(interrupted);
    expect(result.importStatus).toBe("error");
  });
});
