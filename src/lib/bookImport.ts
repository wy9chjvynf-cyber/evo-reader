import {
  clearAllBooks,
  deleteFileBlob,
  getBook,
  getFileBlob,
  getMeta,
  putBook,
  putChunksBatch,
  putFileBlob,
  putSection,
  updateBook,
  type BookRecord,
} from "./db";
import { importPdfIncremental } from "./pdfImport";
import { splitIntoChunks } from "./chunk";
import { detectFormat, extractFullText, titleFromFilename } from "./textExtract";

export interface ImportProgressInfo {
  page: number;
  totalPages: number | null;
  chunksSoFar: number;
  percent: number | null;
}

export interface ImportCallbacks {
  /** Fires once the book row exists (fast) — enough to switch the UI to the reader shell. */
  onCreated?: (book: BookRecord) => void;
  onProgress?: (book: BookRecord, progress: ImportProgressInfo) => void;
  onDone?: (book: BookRecord) => void;
  onError?: (message: string) => void;
}

interface LastSettings {
  rate: number;
  voiceURI: string | null;
}

const TXT_DOCX_BATCH_SIZE = 200;

async function createBookRecord(file: File): Promise<BookRecord> {
  const format = detectFormat(file.name);
  if (!format) throw new Error("Formato no soportado. Usa PDF, TXT o DOCX.");

  const lastSettings = await getMeta<LastSettings>("lastSettings");
  const now = Date.now();
  const book: BookRecord = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: titleFromFilename(file.name),
    format,
    size: file.size,
    totalPages: null,
    totalChunks: 0,
    currentChunk: 0,
    importStatus: "importing",
    importedUntil: 0,
    rate: lastSettings?.rate ?? 1,
    voiceURI: lastSettings?.voiceURI ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await putBook(book);
  return book;
}

async function importTxtOrDocx(book: BookRecord, file: File, callbacks: ImportCallbacks): Promise<BookRecord> {
  const text = await extractFullText(file, book.format as "txt" | "docx");
  const chunks = splitIntoChunks(text);
  if (chunks.length === 0) {
    throw new Error("No se pudo extraer texto de este archivo.");
  }

  await putSection({ bookId: book.id, index: 0, title: null, pageStart: null, pageEnd: null });

  for (let offset = 0; offset < chunks.length; offset += TXT_DOCX_BATCH_SIZE) {
    const slice = chunks.slice(offset, offset + TXT_DOCX_BATCH_SIZE);
    await putChunksBatch(
      slice.map((chunkText, i) => ({
        bookId: book.id,
        index: offset + i,
        sectionIndex: 0,
        sourcePage: null,
        text: chunkText,
      })),
    );
    const chunksSoFar = offset + slice.length;
    const updated = await updateBook(book.id, {
      importedUntil: chunksSoFar,
      totalChunks: chunksSoFar,
      totalPages: chunks.length,
    });
    if (updated) {
      callbacks.onProgress?.(updated, {
        page: chunksSoFar,
        totalPages: chunks.length,
        chunksSoFar,
        percent: Math.round((chunksSoFar / chunks.length) * 100),
      });
    }
  }

  const done = await updateBook(book.id, { importStatus: "done" });
  return done ?? book;
}

async function importPdf(book: BookRecord, file: File, callbacks: ImportCallbacks): Promise<BookRecord> {
  await putFileBlob(book.id, file);
  const data = await file.arrayBuffer();
  await importPdfIncremental(book.id, data, {
    startPage: 1,
    startChunkIndex: 0,
    onProgress: ({ page, totalPages, chunksSoFar }) => {
      void (async () => {
        const updated = await getBook(book.id);
        if (updated) {
          callbacks.onProgress?.(updated, { page, totalPages, chunksSoFar, percent: Math.round((page / totalPages) * 100) });
        }
      })();
    },
  });
  const done = await updateBook(book.id, { importStatus: "done" });
  await deleteFileBlob(book.id);
  return done ?? book;
}

/** The awaitable core — used directly by tests; UI code uses beginImport() below. */
export async function runImport(file: File, callbacks: ImportCallbacks = {}): Promise<BookRecord> {
  await clearAllBooks(); // EvoReader keeps a single active book at a time
  const book = await createBookRecord(file);
  callbacks.onCreated?.(book);

  try {
    const finished = book.format === "pdf" ? await importPdf(book, file, callbacks) : await importTxtOrDocx(book, file, callbacks);
    callbacks.onDone?.(finished);
    return finished;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error al leer el archivo.";
    await updateBook(book.id, { importStatus: "error", errorMessage: message });
    callbacks.onError?.(message);
    throw err;
  }
}

/** Fire-and-forget wrapper for the UI: lets the caller move on once the book row exists. */
export function beginImport(file: File, callbacks: ImportCallbacks): void {
  void runImport(file, callbacks);
}

/** Resumes a pdf import interrupted mid-way (app closed, tab killed, crash). */
export async function runResume(book: BookRecord, callbacks: ImportCallbacks = {}): Promise<BookRecord> {
  if (book.format !== "pdf") {
    const failed = await updateBook(book.id, { importStatus: "error", errorMessage: "Importación incompleta." });
    const message = "No se pudo reanudar la importación de este archivo. Cárgalo de nuevo.";
    callbacks.onError?.(message);
    return failed ?? book;
  }

  const fileRecord = await getFileBlob(book.id);
  if (!fileRecord) {
    const failed = await updateBook(book.id, {
      importStatus: "error",
      errorMessage: "Archivo original no disponible para reanudar.",
    });
    const message = "No se pudo reanudar: el archivo original ya no está disponible. Cárgalo de nuevo.";
    callbacks.onError?.(message);
    return failed ?? book;
  }

  try {
    const data = await fileRecord.blob.arrayBuffer();
    await importPdfIncremental(book.id, data, {
      startPage: book.importedUntil + 1,
      startChunkIndex: book.totalChunks,
      onProgress: ({ page, totalPages, chunksSoFar }) => {
        void (async () => {
          const updated = await getBook(book.id);
          if (updated) {
            callbacks.onProgress?.(updated, { page, totalPages, chunksSoFar, percent: Math.round((page / totalPages) * 100) });
          }
        })();
      },
    });
    const done = await updateBook(book.id, { importStatus: "done" });
    await deleteFileBlob(book.id);
    const finished = done ?? book;
    callbacks.onDone?.(finished);
    return finished;
  } catch (err) {
    const message = err instanceof Error ? err.message : "No se pudo reanudar la importación.";
    const failed = await updateBook(book.id, { importStatus: "error", errorMessage: message });
    callbacks.onError?.(message);
    return failed ?? book;
  }
}

export function beginResume(book: BookRecord, callbacks: ImportCallbacks): void {
  void runResume(book, callbacks);
}
