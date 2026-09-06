import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export type ImportStatus = "importing" | "done" | "error";
export type BookFormat = "pdf" | "txt" | "docx";

export interface BookRecord {
  id: string;
  title: string;
  format: BookFormat;
  size: number;
  /** Known page/unit count once available (pdf: real page count; txt/docx: chunk count once fully chunked). */
  totalPages: number | null;
  /** Chunks persisted so far — grows during import, final once importStatus is "done". */
  totalChunks: number;
  /** Playback position (chunk index). */
  currentChunk: number;
  importStatus: ImportStatus;
  /** Last fully-committed page (pdf) or chunk-batch offset (txt/docx) — resume point. */
  importedUntil: number;
  rate: number;
  voiceURI: string | null;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SectionRecord {
  bookId: string;
  index: number;
  title: string | null;
  pageStart: number | null;
  pageEnd: number | null;
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

interface EvoReaderDB extends DBSchema {
  books: { key: string; value: BookRecord };
  sections: { key: [string, number]; value: SectionRecord };
  chunks: { key: [string, number]; value: ChunkRecord };
  files: { key: string; value: FileBlobRecord };
  meta: { key: string; value: { key: string; value: unknown } };
}

const DB_NAME = "evoreader";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<EvoReaderDB>> | null = null;

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<EvoReaderDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore("books", { keyPath: "id" });
        db.createObjectStore("sections", { keyPath: ["bookId", "index"] });
        db.createObjectStore("chunks", { keyPath: ["bookId", "index"] });
        db.createObjectStore("files", { keyPath: "bookId" });
        db.createObjectStore("meta", { keyPath: "key" });
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

// --- books ---

export const putBook = (book: BookRecord) => safely(async () => (await getDB()).put("books", book));
export const getBook = (id: string) => safely(async () => (await getDB()).get("books", id));
export const deleteBook = (id: string) => safely(async () => (await getDB()).delete("books", id));
export const getAllBooks = async (): Promise<BookRecord[]> => (await safely(async () => (await getDB()).getAll("books"))) ?? [];

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
    const updated: BookRecord = { ...existing, ...patch, updatedAt: Date.now() };
    await tx.store.put(updated);
    await tx.done;
    return updated;
  });
}

// --- sections ---

export const putSection = (section: SectionRecord) => safely(async () => (await getDB()).put("sections", section));

export const getSections = async (bookId: string): Promise<SectionRecord[]> =>
  (await safely(async () => {
    const db = await getDB();
    const range = IDBKeyRange.bound([bookId, 0], [bookId, Number.MAX_SAFE_INTEGER]);
    return db.getAll("sections", range);
  })) ?? [];

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

// --- files (raw bytes kept only while a pdf import is resumable) ---

export const putFileBlob = (bookId: string, blob: Blob) => safely(async () => (await getDB()).put("files", { bookId, blob }));
export const getFileBlob = (bookId: string) => safely(async () => (await getDB()).get("files", bookId));
export const deleteFileBlob = (bookId: string) => safely(async () => (await getDB()).delete("files", bookId));

// --- meta (small book-independent values, e.g. last-used rate/voice) ---

export const putMeta = (key: string, value: unknown) => safely(async () => (await getDB()).put("meta", { key, value }));
export async function getMeta<T>(key: string): Promise<T | undefined> {
  const record = await safely(async () => (await getDB()).get("meta", key));
  return record?.value as T | undefined;
}

/** Fully removes a book and everything that belongs to it. */
export async function deleteBookCascade(bookId: string): Promise<void> {
  await Promise.all([deleteBookChunks(bookId), deleteBookSections(bookId), deleteFileBlob(bookId), deleteBook(bookId)]);
}

/** EvoReader keeps one active book; call before starting a new import. */
export async function clearAllBooks(): Promise<void> {
  const books = await getAllBooks();
  await Promise.all(books.map((b) => deleteBookCascade(b.id)));
}
