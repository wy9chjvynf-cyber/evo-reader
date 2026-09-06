import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export type ImportStatus = "importing" | "done" | "error";
export type BookFormat = "pdf" | "txt" | "md" | "docx" | "epub";
/** Coarse stage for user-facing error messages — never show a raw stack trace. */
export type ImportStage = "opening" | "metadata" | "structure" | "extracting" | "worker" | "persisting" | "done";

export interface BookRecord {
  id: string;
  title: string;
  author: string | null;
  language: string | null;
  format: BookFormat;
  size: number;
  /** Known page count (pdf) once available; null for formats without pages. */
  totalPages: number | null;
  totalSections: number;
  /** Chunks persisted so far — grows during import, final once importStatus is "done". */
  totalChunks: number;
  /** Approximate word count accumulated during chunking — backs the time estimate. */
  wordCount: number;
  /** Playback position. */
  currentSection: number;
  currentChunk: number;
  importStatus: ImportStatus;
  importStage: ImportStage;
  /** 0-100, best-known-so-far while importing. */
  importProgress: number;
  /** Last fully-committed page (pdf/epub) or chunk-batch offset (txt/docx/md) — resume point. */
  importedUntil: number;
  hasCover: boolean;
  rate: number;
  voiceURI: string | null;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
}

export interface SectionRecord {
  bookId: string;
  index: number;
  title: string | null;
  /** Heading level when known (1 = top-level chapter), for TOC indentation. */
  level: number;
  sourceType: "page" | "spine" | "heading" | "whole";
  sourceStart: number | null;
  sourceEnd: number | null;
  /** Undefined/null while the section is still being written to (import in progress). */
  firstChunkIndex: number | null;
  lastChunkIndex: number | null;
  wordCount: number;
}

export interface ChunkRecord {
  bookId: string;
  index: number;
  sectionIndex: number;
  sourcePage: number | null;
  text: string;
}

export interface FileBlobRecord {
  bookId: string;
  blob: Blob;
}

export interface CoverRecord {
  bookId: string;
  blob: Blob;
}

interface EvoReaderDB extends DBSchema {
  books: { key: string; value: BookRecord };
  sections: { key: [string, number]; value: SectionRecord };
  chunks: { key: [string, number]; value: ChunkRecord };
  files: { key: string; value: FileBlobRecord };
  covers: { key: string; value: CoverRecord };
  meta: { key: string; value: { key: string; value: unknown } };
}

const DB_NAME = "evoreader";
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase<EvoReaderDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<EvoReaderDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          db.createObjectStore("books", { keyPath: "id" });
          db.createObjectStore("sections", { keyPath: ["bookId", "index"] });
          db.createObjectStore("chunks", { keyPath: ["bookId", "index"] });
          db.createObjectStore("files", { keyPath: "bookId" });
          db.createObjectStore("meta", { keyPath: "key" });
        }
        if (oldVersion < 2) {
          db.createObjectStore("covers", { keyPath: "bookId" });
          // Existing v1 records are missing the new BookRecord/SectionRecord
          // fields (author, level, firstChunkIndex, ...). Nothing to do here:
          // every reader below fills sensible defaults for missing fields,
          // and ensureBookSections() backfills a section's chunk range the
          // first time a v1 book (which already had per-page/whole-document
          // section rows, just without firstChunkIndex/lastChunkIndex) is
          // opened again — no forced re-import.
        }
      },
    });
  }
  return dbPromise;
}

/**
 * All IndexedDB access goes through here so a broken/partial implementation
 * on some WebKit build degrades to "nothing saved" instead of an uncaught
 * exception (see the iOS init-crash hotfix this app already shipped once).
 */
async function safely<T>(op: () => Promise<T>): Promise<T | undefined> {
  try {
    return await op();
  } catch {
    return undefined;
  }
}

function withBookDefaults(book: BookRecord): BookRecord {
  // Backfills fields that didn't exist on Phase 1 records.
  return {
    ...book,
    author: book.author ?? null,
    language: book.language ?? null,
    totalSections: book.totalSections ?? 1,
    wordCount: book.wordCount ?? 0,
    currentSection: book.currentSection ?? 0,
    importStage: book.importStage ?? (book.importStatus === "done" ? "done" : "extracting"),
    importProgress: book.importProgress ?? (book.importStatus === "done" ? 100 : 0),
    hasCover: book.hasCover ?? false,
    lastOpenedAt: book.lastOpenedAt ?? book.updatedAt,
  };
}

function withSectionDefaults(section: SectionRecord): SectionRecord {
  return {
    ...section,
    level: section.level ?? 1,
    sourceType: section.sourceType ?? "whole",
    wordCount: section.wordCount ?? 0,
  };
}

// --- books ---

export const putBook = (book: BookRecord) => safely(async () => (await getDB()).put("books", book));
export const getBook = async (id: string): Promise<BookRecord | undefined> => {
  const raw = await safely(async () => (await getDB()).get("books", id));
  return raw ? withBookDefaults(raw) : undefined;
};
export const deleteBook = (id: string) => safely(async () => (await getDB()).delete("books", id));
export const getAllBooks = async (): Promise<BookRecord[]> =>
  ((await safely(async () => (await getDB()).getAll("books"))) ?? []).map(withBookDefaults);

/** EvoReader keeps a single active book at a time; this is the one, if any. */
export const getActiveBook = async (): Promise<BookRecord | undefined> => (await getAllBooks())[0];

export async function updateBook(id: string, patch: Partial<BookRecord>): Promise<BookRecord | undefined> {
  return safely(async () => {
    const db = await getDB();
    const tx = db.transaction("books", "readwrite");
    const existing = await tx.store.get(id);
    if (!existing) {
      await tx.done;
      return undefined;
    }
    const updated: BookRecord = { ...withBookDefaults(existing), ...patch, updatedAt: Date.now() };
    await tx.store.put(updated);
    await tx.done;
    return updated;
  });
}

// --- sections ---

export const putSection = (section: SectionRecord) => safely(async () => (await getDB()).put("sections", section));

export const getSections = async (bookId: string): Promise<SectionRecord[]> =>
  (
    (await safely(async () => {
      const db = await getDB();
      const range = IDBKeyRange.bound([bookId, 0], [bookId, Number.MAX_SAFE_INTEGER]);
      return db.getAll("sections", range);
    })) ?? []
  ).map(withSectionDefaults);

export const getSection = async (bookId: string, index: number): Promise<SectionRecord | undefined> => {
  const raw = await safely(async () => (await getDB()).get("sections", [bookId, index]));
  return raw ? withSectionDefaults(raw) : undefined;
};

export async function updateSection(bookId: string, index: number, patch: Partial<SectionRecord>): Promise<void> {
  await safely(async () => {
    const db = await getDB();
    const tx = db.transaction("sections", "readwrite");
    const existing = await tx.store.get([bookId, index]);
    if (!existing) {
      await tx.done;
      return;
    }
    await tx.store.put({ ...withSectionDefaults(existing), ...patch });
    await tx.done;
  });
}

/**
 * Phase 1 books already have one section row per page (pdf) or a single
 * whole-document row (txt/docx), but without firstChunkIndex/lastChunkIndex.
 * Backfills those from the chunks store, once, so old books stay usable
 * without a forced re-import. No-op for books that already have them.
 */
export async function ensureBookSections(bookId: string): Promise<void> {
  await safely(async () => {
    const sections = await getSections(bookId);
    if (sections.length === 0) return; // nothing to backfill from (shouldn't happen post-Phase-1)
    const needsBackfill = sections.some((s) => s.firstChunkIndex === null || s.firstChunkIndex === undefined);
    if (!needsBackfill) return;

    const db = await getDB();
    const range = IDBKeyRange.bound([bookId, 0], [bookId, Number.MAX_SAFE_INTEGER]);
    const chunks = await db.getAll("chunks", range);
    const bySection = new Map<number, number[]>();
    for (const c of chunks) {
      const list = bySection.get(c.sectionIndex) ?? [];
      list.push(c.index);
      bySection.set(c.sectionIndex, list);
    }

    for (const section of sections) {
      if (section.firstChunkIndex !== null && section.firstChunkIndex !== undefined) continue;
      const indices = bySection.get(section.index);
      if (!indices || indices.length === 0) continue;
      await putSection({
        ...section,
        firstChunkIndex: Math.min(...indices),
        lastChunkIndex: Math.max(...indices),
      });
    }
  });
}

async function deleteBookSections(bookId: string): Promise<void> {
  await safely(async () => {
    const db = await getDB();
    const range = IDBKeyRange.bound([bookId, 0], [bookId, Number.MAX_SAFE_INTEGER]);
    const tx = db.transaction("sections", "readwrite");
    let cursor = await tx.store.openCursor(range);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  });
}

// --- chunks ---

export async function putChunksBatch(chunks: ChunkRecord[]): Promise<void> {
  if (chunks.length === 0) return;
  await safely(async () => {
    const db = await getDB();
    const tx = db.transaction("chunks", "readwrite");
    await Promise.all(chunks.map((c) => tx.store.put(c)));
    await tx.done;
  });
}

export const getChunk = (bookId: string, index: number) => safely(async () => (await getDB()).get("chunks", [bookId, index]));

export async function getChunkRange(bookId: string, start: number, end: number): Promise<ChunkRecord[]> {
  return (
    (await safely(async () => {
      const db = await getDB();
      const range = IDBKeyRange.bound([bookId, start], [bookId, end]);
      return db.getAll("chunks", range);
    })) ?? []
  );
}

export async function deleteBookChunks(bookId: string): Promise<void> {
  await safely(async () => {
    const db = await getDB();
    const range = IDBKeyRange.bound([bookId, 0], [bookId, Number.MAX_SAFE_INTEGER]);
    const tx = db.transaction("chunks", "readwrite");
    let cursor = await tx.store.openCursor(range);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  });
}

// --- files (raw bytes kept only while a pdf/epub import is resumable) ---

export const putFileBlob = (bookId: string, blob: Blob) => safely(async () => (await getDB()).put("files", { bookId, blob }));
export const getFileBlob = (bookId: string) => safely(async () => (await getDB()).get("files", bookId));
export const deleteFileBlob = (bookId: string) => safely(async () => (await getDB()).delete("files", bookId));

// --- covers (small thumbnails, kept permanently) ---

export const putCover = (bookId: string, blob: Blob) => safely(async () => (await getDB()).put("covers", { bookId, blob }));
export const getCover = (bookId: string) => safely(async () => (await getDB()).get("covers", bookId));
const deleteCover = (bookId: string) => safely(async () => (await getDB()).delete("covers", bookId));

// --- meta (small book-independent values, e.g. last-used rate/voice) ---

export const putMeta = (key: string, value: unknown) => safely(async () => (await getDB()).put("meta", { key, value }));
export async function getMeta<T>(key: string): Promise<T | undefined> {
  const record = await safely(async () => (await getDB()).get("meta", key));
  return record?.value as T | undefined;
}

/** Fully removes a book and everything that belongs to it. */
export async function deleteBookCascade(bookId: string): Promise<void> {
  await Promise.all([
    deleteBookChunks(bookId),
    deleteBookSections(bookId),
    deleteFileBlob(bookId),
    deleteCover(bookId),
    deleteBook(bookId),
  ]);
}

/** EvoReader keeps one active book; call before starting a new import. */
export async function clearAllBooks(): Promise<void> {
  const books = await getAllBooks();
  await Promise.all(books.map((b) => deleteBookCascade(b.id)));
}

// --- lightweight storage-usage estimate for the diagnostics view ---

export async function estimateStorageUsage(): Promise<{ usage: number; quota: number } | undefined> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return undefined;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage: usage ?? 0, quota: quota ?? 0 };
  } catch {
    return undefined;
  }
}
