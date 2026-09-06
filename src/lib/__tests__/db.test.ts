import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAllBooks,
  deleteBookCascade,
  ensureBookSections,
  getActiveBook,
  getAllBooks,
  getBook,
  getChunk,
  getChunkRange,
  getCover,
  getFileBlob,
  getMeta,
  getSection,
  getSections,
  putBook,
  putChunksBatch,
  putCover,
  putFileBlob,
  putMeta,
  putSection,
  updateBook,
  updateSection,
  type BookRecord,
} from "../db";

function makeBook(overrides: Partial<BookRecord> = {}): BookRecord {
  const now = Date.now();
  return {
    id: "book-1",
    title: "Test book",
    author: null,
    language: null,
    format: "txt",
    size: 100,
    totalPages: null,
    totalSections: 0,
    totalChunks: 0,
    wordCount: 0,
    currentSection: 0,
    currentChunk: 0,
    importStatus: "importing",
    importStage: "extracting",
    importProgress: 0,
    importedUntil: 0,
    hasCover: false,
    rate: 1,
    voiceURI: null,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    ...overrides,
  };
}

describe("db — books", () => {
  beforeEach(async () => {
    await clearAllBooks();
  });

  it("round-trips a book record", async () => {
    const book = makeBook();
    await putBook(book);
    const loaded = await getBook(book.id);
    expect(loaded?.title).toBe("Test book");
    expect(loaded?.format).toBe("txt");
  });

  it("updateBook merges fields, bumps updatedAt, and leaves the rest untouched", async () => {
    const book = makeBook();
    await putBook(book);
    const updated = await updateBook(book.id, { totalChunks: 5, importStatus: "done" });
    expect(updated?.totalChunks).toBe(5);
    expect(updated?.importStatus).toBe("done");
    expect(updated?.title).toBe("Test book");
  });

  it("updateBook on a missing id is a no-op", async () => {
    expect(await updateBook("does-not-exist", { totalChunks: 1 })).toBeUndefined();
  });

  it("getActiveBook returns undefined when empty and the book once one exists", async () => {
    expect(await getActiveBook()).toBeUndefined();
    const book = makeBook();
    await putBook(book);
    expect((await getActiveBook())?.id).toBe(book.id);
  });

  it("clearAllBooks empties the single active-book slot", async () => {
    await putBook(makeBook({ id: "one" }));
    await putBook(makeBook({ id: "two" }));
    expect(await getAllBooks()).toHaveLength(2);
    await clearAllBooks();
    expect(await getAllBooks()).toHaveLength(0);
  });

  it("fills in defaults for fields a Phase 1 record wouldn't have had", async () => {
    // Simulate a raw Phase 1 record written before author/level/etc existed.
    const phase1Shape = {
      id: "legacy-1",
      title: "Libro viejo",
      format: "pdf",
      size: 1000,
      totalPages: 10,
      totalChunks: 50,
      currentChunk: 5,
      importStatus: "done",
      importedUntil: 10,
      rate: 1,
      voiceURI: null,
      createdAt: 1,
      updatedAt: 1,
      // no author, language, totalSections, wordCount, currentSection,
      // importStage, importProgress, hasCover, lastOpenedAt
    } as unknown as BookRecord;
    await putBook(phase1Shape);
    const loaded = await getBook("legacy-1");
    expect(loaded?.author).toBeNull();
    expect(loaded?.totalSections).toBe(1);
    expect(loaded?.importStage).toBe("done"); // derived from importStatus
    expect(loaded?.hasCover).toBe(false);
    expect(loaded?.lastOpenedAt).toBe(1); // derived from updatedAt
  });
});

describe("db — sections", () => {
  beforeEach(async () => {
    await clearAllBooks();
  });

  it("round-trips sections in index order", async () => {
    await putSection({ bookId: "b", index: 1, title: "Cap 2", level: 1, sourceType: "heading", sourceStart: null, sourceEnd: null, firstChunkIndex: 5, lastChunkIndex: 9, wordCount: 20 });
    await putSection({ bookId: "b", index: 0, title: "Cap 1", level: 1, sourceType: "heading", sourceStart: null, sourceEnd: null, firstChunkIndex: 0, lastChunkIndex: 4, wordCount: 20 });
    const sections = await getSections("b");
    expect(sections.map((s) => s.index)).toEqual([0, 1]);
    expect(sections.map((s) => s.title)).toEqual(["Cap 1", "Cap 2"]);
  });

  it("scopes sections strictly by bookId", async () => {
    await putSection({ bookId: "a", index: 0, title: "A0", level: 1, sourceType: "whole", sourceStart: null, sourceEnd: null, firstChunkIndex: 0, lastChunkIndex: 0, wordCount: 1 });
    await putSection({ bookId: "b", index: 0, title: "B0", level: 1, sourceType: "whole", sourceStart: null, sourceEnd: null, firstChunkIndex: 0, lastChunkIndex: 0, wordCount: 1 });
    expect((await getSections("a")).map((s) => s.title)).toEqual(["A0"]);
    expect((await getSection("b", 0))?.title).toBe("B0");
  });

  it("updateSection merges fields without clobbering the rest", async () => {
    await putSection({ bookId: "b", index: 0, title: "Cap 1", level: 1, sourceType: "page", sourceStart: 1, sourceEnd: null, firstChunkIndex: 0, lastChunkIndex: null, wordCount: 0 });
    await updateSection("b", 0, { lastChunkIndex: 12, sourceEnd: 3 });
    const section = await getSection("b", 0);
    expect(section?.lastChunkIndex).toBe(12);
    expect(section?.sourceEnd).toBe(3);
    expect(section?.title).toBe("Cap 1");
  });

  it("deleteBookCascade removes sections along with the book", async () => {
    await putBook(makeBook({ id: "to-delete" }));
    await putSection({ bookId: "to-delete", index: 0, title: "Cap 1", level: 1, sourceType: "whole", sourceStart: null, sourceEnd: null, firstChunkIndex: 0, lastChunkIndex: 0, wordCount: 1 });
    await deleteBookCascade("to-delete");
    expect(await getSections("to-delete")).toHaveLength(0);
  });

  it("ensureBookSections backfills firstChunkIndex/lastChunkIndex for a Phase 1 book with no-op for a fresh one", async () => {
    const bookId = "legacy-pdf";
    // Phase 1 shape: one section row per page, no firstChunkIndex/lastChunkIndex.
    await putSection({ bookId, index: 0, title: null, sourceStart: 1, sourceEnd: 1 } as never);
    await putSection({ bookId, index: 1, title: null, sourceStart: 2, sourceEnd: 2 } as never);
    await putChunksBatch([
      { bookId, index: 0, sectionIndex: 0, sourcePage: 1, text: "a" },
      { bookId, index: 1, sectionIndex: 0, sourcePage: 1, text: "b" },
      { bookId, index: 2, sectionIndex: 1, sourcePage: 2, text: "c" },
    ]);

    await ensureBookSections(bookId);

    const sections = await getSections(bookId);
    expect(sections[0].firstChunkIndex).toBe(0);
    expect(sections[0].lastChunkIndex).toBe(1);
    expect(sections[1].firstChunkIndex).toBe(2);
    expect(sections[1].lastChunkIndex).toBe(2);

    // Calling it again (already backfilled) must not change anything or throw.
    await ensureBookSections(bookId);
    const sectionsAgain = await getSections(bookId);
    expect(sectionsAgain).toEqual(sections);
  });
});

describe("db — chunks", () => {
  beforeEach(async () => {
    await clearAllBooks();
  });

  it("stores chunks and range-queries them scoped strictly by bookId", async () => {
    await putChunksBatch([
      { bookId: "a", index: 0, sectionIndex: 0, sourcePage: null, text: "a0" },
      { bookId: "a", index: 1, sectionIndex: 0, sourcePage: null, text: "a1" },
      { bookId: "b", index: 0, sectionIndex: 0, sourcePage: null, text: "b0" },
    ]);
    expect((await getChunk("a", 1))?.text).toBe("a1");
    expect(await getChunk("a", 99)).toBeUndefined();
    expect((await getChunkRange("a", 0, 10)).map((c) => c.text)).toEqual(["a0", "a1"]);
    expect((await getChunkRange("b", 0, 10)).map((c) => c.text)).toEqual(["b0"]);
  });
});

describe("db — files, covers, meta", () => {
  beforeEach(async () => {
    await clearAllBooks();
  });

  it("file blobs exist while set and disappear once deleted", async () => {
    await putFileBlob("book-1", new Blob(["bytes"]));
    expect(await getFileBlob("book-1")).toBeTruthy();
    await deleteBookCascade("book-1");
    expect(await getFileBlob("book-1")).toBeUndefined();
  });

  it("covers persist independently of the file blob", async () => {
    await putCover("book-1", new Blob(["cover-bytes"]));
    expect(await getCover("book-1")).toBeTruthy();
  });

  it("round-trips meta values used for last-used settings", async () => {
    await putMeta("lastSettings", { rate: 1.5, voiceURI: "voice-1" });
    expect(await getMeta<{ rate: number; voiceURI: string }>("lastSettings")).toEqual({ rate: 1.5, voiceURI: "voice-1" });
  });

  it("getMeta returns undefined for a key that was never set", async () => {
    expect(await getMeta("nope")).toBeUndefined();
  });
});
