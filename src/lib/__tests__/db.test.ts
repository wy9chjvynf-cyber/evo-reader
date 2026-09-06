import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAllBooks,
  deleteBookCascade,
  getActiveBook,
  getAllBooks,
  getBook,
  getChunk,
  getChunkRange,
  getFileBlob,
  getMeta,
  putBook,
  putChunksBatch,
  putFileBlob,
  putMeta,
  updateBook,
  type BookRecord,
} from "../db";

function makeBook(overrides: Partial<BookRecord> = {}): BookRecord {
  const now = Date.now();
  return {
    id: "book-1",
    title: "Test book",
    format: "txt",
    size: 100,
    totalPages: null,
    totalChunks: 0,
    currentChunk: 0,
    importStatus: "importing",
    importedUntil: 0,
    rate: 1,
    voiceURI: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("db", () => {
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
    const before = book.updatedAt;
    const updated = await updateBook(book.id, { totalChunks: 5, importStatus: "done" });
    expect(updated?.totalChunks).toBe(5);
    expect(updated?.importStatus).toBe("done");
    expect(updated?.title).toBe("Test book");
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("updateBook on a missing id is a no-op", async () => {
    const result = await updateBook("does-not-exist", { totalChunks: 1 });
    expect(result).toBeUndefined();
  });

  it("getActiveBook returns undefined when empty and the book once one exists", async () => {
    expect(await getActiveBook()).toBeUndefined();
    const book = makeBook();
    await putBook(book);
    expect((await getActiveBook())?.id).toBe(book.id);
  });

  it("stores chunks and range-queries them scoped strictly by bookId", async () => {
    await putChunksBatch([
      { bookId: "a", index: 0, sectionIndex: 0, sourcePage: null, text: "a0" },
      { bookId: "a", index: 1, sectionIndex: 0, sourcePage: null, text: "a1" },
      { bookId: "b", index: 0, sectionIndex: 0, sourcePage: null, text: "b0" },
    ]);

    expect((await getChunk("a", 1))?.text).toBe("a1");
    expect(await getChunk("a", 99)).toBeUndefined();

    const rangeA = await getChunkRange("a", 0, 10);
    expect(rangeA.map((c) => c.text)).toEqual(["a0", "a1"]);

    const rangeB = await getChunkRange("b", 0, 10);
    expect(rangeB.map((c) => c.text)).toEqual(["b0"]);
  });

  it("deleteBookCascade removes the book, its chunks, and its file blob", async () => {
    const book = makeBook({ id: "to-delete" });
    await putBook(book);
    await putChunksBatch([{ bookId: "to-delete", index: 0, sectionIndex: 0, sourcePage: null, text: "x" }]);
    await putFileBlob("to-delete", new Blob(["bytes"]));

    await deleteBookCascade("to-delete");

    expect(await getBook("to-delete")).toBeUndefined();
    expect(await getChunk("to-delete", 0)).toBeUndefined();
    expect(await getFileBlob("to-delete")).toBeUndefined();
  });

  it("clearAllBooks empties the single active-book slot", async () => {
    await putBook(makeBook({ id: "one" }));
    await putBook(makeBook({ id: "two" }));
    expect(await getAllBooks()).toHaveLength(2);

    await clearAllBooks();
    expect(await getAllBooks()).toHaveLength(0);
  });

  it("round-trips meta values used for last-used settings", async () => {
    await putMeta("lastSettings", { rate: 1.5, voiceURI: "voice-1" });
    const value = await getMeta<{ rate: number; voiceURI: string }>("lastSettings");
    expect(value).toEqual({ rate: 1.5, voiceURI: "voice-1" });
  });

  it("getMeta returns undefined for a key that was never set", async () => {
    expect(await getMeta("nope")).toBeUndefined();
  });
});
