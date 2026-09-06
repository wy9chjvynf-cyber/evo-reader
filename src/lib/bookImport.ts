import {
  clearAllBooks,
  deleteFileBlob,
  getBook,
  getFileBlob,
  getMeta,
  getSections,
  putBook,
  putCover,
  putFileBlob,
  updateBook,
  type BookFormat,
  type BookRecord,
} from "./db";
import { importPdfIncremental, type OpenSectionState } from "./pdfImport";
import { importEpubIncremental } from "./epubImport";
import { extractDocxSegments } from "./docxImport";
import { buildMarkdownSegments, buildTxtSegments } from "./textImport";
import { persistSegments } from "./sectionBuilder";
import { titleFromFilename } from "./textExtract";

export interface ImportProgressInfo {
  page: number;
  totalPages: number | null;
  chunksSoFar: number;
  percent: number | null;
  /** True once enough content exists to start Play, even if import continues. */
  playable: boolean;
}

export interface ImportCallbacks {
  /** Fires once the book row exists (fast) — enough to switch the UI to the reader shell. */
  onCreated?: (book: BookRecord) => void;
  onProgress?: (book: BookRecord, progress: ImportProgressInfo) => void;
  onDone?: (book: BookRecord) => void;
  onError?: (message: string, stage: BookRecord["importStage"]) => void;
}

interface LastSettings {
  rate: number;
  voiceURI: string | null;
}

function detectFormat(filename: string): BookFormat | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "txt") return "txt";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "docx") return "docx";
  if (ext === "epub") return "epub";
  return null;
}

async function createBookRecord(file: File, format: BookFormat): Promise<BookRecord> {
  const lastSettings = await getMeta<LastSettings>("lastSettings");
  const now = Date.now();
  const book: BookRecord = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    title: titleFromFilename(file.name),
    author: null,
    language: null,
    format,
    size: file.size,
    totalPages: null,
    totalSections: 0,
    totalChunks: 0,
    wordCount: 0,
    currentSection: 0,
    currentChunk: 0,
    importStatus: "importing",
    importStage: "opening",
    importProgress: 0,
    importedUntil: 0,
    hasCover: false,
    rate: lastSettings?.rate ?? 1,
    voiceURI: lastSettings?.voiceURI ?? null,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
  };
  await putBook(book);
  return book;
}

function friendlyError(err: unknown, fallbackStage: BookRecord["importStage"]): { message: string; stage: BookRecord["importStage"] } {
  if (err instanceof StagedImportError) return { message: err.message, stage: err.stage };
  const message = err instanceof Error ? err.message : "No se pudo leer el archivo.";
  return { message, stage: fallbackStage };
}

class StagedImportError extends Error {
  stage: BookRecord["importStage"];
  constructor(message: string, stage: BookRecord["importStage"]) {
    super(message);
    this.stage = stage;
  }
}

// --- txt / md / docx: whole-document extraction, then chunked+persisted in one pass ---

async function importWholeDocument(
  book: BookRecord,
  file: File,
  callbacks: ImportCallbacks,
): Promise<BookRecord> {
  await updateBook(book.id, { importStage: "extracting" });

  let segments;
  try {
    if (book.format === "txt") {
      segments = buildTxtSegments(await file.text());
    } else if (book.format === "md") {
      segments = buildMarkdownSegments(await file.text());
    } else {
      segments = await extractDocxSegments(file);
    }
  } catch (err) {
    throw new StagedImportError(err instanceof Error ? err.message : "No se pudo extraer el texto del archivo.", "extracting");
  }

  if (segments.every((s) => !s.text.trim())) {
    throw new StagedImportError("No se pudo extraer texto de este archivo.", "extracting");
  }

  await updateBook(book.id, { importStage: "persisting" });
  const totalSegments = segments.length;
  const result = await persistSegments(book.id, segments, { sectionIndex: 0, chunkIndex: 0 }, (done, total, chunksSoFar) => {
    void (async () => {
      const updated = await updateBook(book.id, {
        totalChunks: chunksSoFar,
        totalSections: done,
        totalPages: total,
        importedUntil: done,
        importProgress: Math.round((done / total) * 100),
      });
      if (updated) {
        callbacks.onProgress?.(updated, {
          page: done,
          totalPages: total,
          chunksSoFar,
          percent: Math.round((done / total) * 100),
          playable: chunksSoFar > 0,
        });
      }
    })();
  });
  void totalSegments;

  const done = await updateBook(book.id, {
    importStatus: "done",
    importStage: "done",
    importProgress: 100,
    totalChunks: result.chunkIndex,
    totalSections: result.sectionIndex,
    wordCount: result.wordCount,
    importedUntil: segments.length,
  });
  return done ?? book;
}

// --- pdf ---

async function importPdf(book: BookRecord, file: File, callbacks: ImportCallbacks): Promise<BookRecord> {
  await updateBook(book.id, { importStage: "opening" });
  await putFileBlob(book.id, file);
  const data = await file.arrayBuffer();

  await updateBook(book.id, { importStage: "structure" });
  let result;
  try {
    result = await importPdfIncremental(book.id, data, {
      startPage: 1,
      startChunkIndex: 0,
      nextSectionIndex: 0,
      openSection: null,
      onCover: (blob) => {
        // putCover degrades to undefined (not a rejection) if IndexedDB can't
        // store this Blob on this device — only claim hasCover when it
        // actually landed, so the UI never tries to load a cover that isn't there.
        void putCover(book.id, blob).then((stored) => {
          if (stored) void updateBook(book.id, { hasCover: true });
        });
      },
      onProgress: ({ page, totalPages, chunksSoFar }) => {
        void (async () => {
          const updated = await getBook(book.id);
          if (updated) {
            callbacks.onProgress?.(updated, {
              page,
              totalPages,
              chunksSoFar,
              percent: Math.round((page / totalPages) * 100),
              playable: chunksSoFar > 0,
            });
          }
        })();
      },
    });
  } catch (err) {
    throw new StagedImportError(err instanceof Error ? err.message : "No se pudo procesar el PDF.", "extracting");
  }

  const done = await updateBook(book.id, {
    importStatus: "done",
    importStage: "done",
    importProgress: 100,
    totalPages: result.totalPages,
    totalChunks: result.totalChunks,
    totalSections: result.totalSections,
    wordCount: result.wordCount,
  });
  await deleteFileBlob(book.id);
  return done ?? book;
}

// --- epub ---

async function importEpub(book: BookRecord, file: File, callbacks: ImportCallbacks): Promise<BookRecord> {
  await updateBook(book.id, { importStage: "opening" });
  await putFileBlob(book.id, file);
  const data = await file.arrayBuffer();

  await updateBook(book.id, { importStage: "metadata" });
  let result;
  try {
    result = await importEpubIncremental(book.id, data, {
      startSpineIndex: 0,
      startSectionIndex: 0,
      startChunkIndex: 0,
      onMetadata: (metadata, coverBlob) => {
        void updateBook(book.id, {
          title: metadata.title ?? book.title,
          author: metadata.author,
          language: metadata.language,
          importStage: "extracting",
        });
        if (coverBlob) {
          void putCover(book.id, coverBlob).then((stored) => {
            if (stored) void updateBook(book.id, { hasCover: true });
          });
        }
      },
      onProgress: ({ spineIndex, totalSpineItems, chunksSoFar }) => {
        void (async () => {
          const updated = await getBook(book.id);
          if (updated) {
            callbacks.onProgress?.(updated, {
              page: spineIndex,
              totalPages: totalSpineItems,
              chunksSoFar,
              percent: Math.round((spineIndex / totalSpineItems) * 100),
              playable: chunksSoFar > 0,
            });
          }
        })();
      },
    });
  } catch (err) {
    throw new StagedImportError(err instanceof Error ? err.message : "No se pudo procesar el EPUB.", "structure");
  }

  const done = await updateBook(book.id, {
    importStatus: "done",
    importStage: "done",
    importProgress: 100,
    title: result.metadata.title ?? book.title,
    author: result.metadata.author,
    language: result.metadata.language,
    totalPages: result.totalSpineItems,
    totalChunks: result.totalChunks,
    totalSections: result.totalSections,
    wordCount: result.wordCount,
  });
  await deleteFileBlob(book.id);
  return done ?? book;
}

/** The awaitable core — used directly by tests; UI code uses beginImport() below. */
export async function runImport(file: File, callbacks: ImportCallbacks = {}): Promise<BookRecord> {
  const format = detectFormat(file.name);
  if (!format) throw new Error("Formato no soportado. Usa PDF, EPUB, DOCX, TXT o MD.");

  await clearAllBooks(); // EvoReader keeps a single active book at a time
  const book = await createBookRecord(file, format);
  callbacks.onCreated?.(book);

  try {
    let finished: BookRecord;
    if (format === "pdf") finished = await importPdf(book, file, callbacks);
    else if (format === "epub") finished = await importEpub(book, file, callbacks);
    else finished = await importWholeDocument(book, file, callbacks);
    callbacks.onDone?.(finished);
    return finished;
  } catch (err) {
    const { message, stage } = friendlyError(err, "extracting");
    await updateBook(book.id, { importStatus: "error", importStage: stage, errorMessage: message });
    callbacks.onError?.(message, stage);
    throw err;
  }
}

/** Fire-and-forget wrapper for the UI: lets the caller move on once the book row exists. */
export function beginImport(file: File, callbacks: ImportCallbacks): void {
  void runImport(file, callbacks);
}

async function findOpenPdfSection(bookId: string): Promise<OpenSectionState | null> {
  const sections = await getSections(bookId);
  const open = sections.find((s) => s.lastChunkIndex === null || s.lastChunkIndex === undefined);
  if (!open || open.firstChunkIndex === null || open.firstChunkIndex === undefined) return null;
  return { index: open.index, title: open.title, firstChunkIndex: open.firstChunkIndex, sourceStart: open.sourceStart ?? 1 };
}

/** Resumes a pdf/epub import interrupted mid-way (app closed, tab killed, crash). */
export async function runResume(book: BookRecord, callbacks: ImportCallbacks = {}): Promise<BookRecord> {
  if (book.format !== "pdf" && book.format !== "epub") {
    const failed = await updateBook(book.id, { importStatus: "error", importStage: "extracting", errorMessage: "Importación incompleta." });
    const message = "No se pudo reanudar la importación de este archivo. Cárgalo de nuevo.";
    callbacks.onError?.(message, "extracting");
    return failed ?? book;
  }

  const fileRecord = await getFileBlob(book.id);
  if (!fileRecord) {
    const failed = await updateBook(book.id, {
      importStatus: "error",
      importStage: "extracting",
      errorMessage: "Archivo original no disponible para reanudar.",
    });
    const message = "No se pudo reanudar: el archivo original ya no está disponible. Cárgalo de nuevo.";
    callbacks.onError?.(message, "extracting");
    return failed ?? book;
  }

  try {
    const data = await fileRecord.blob.arrayBuffer();
    let done: BookRecord | undefined;

    if (book.format === "pdf") {
      const openSection = await findOpenPdfSection(book.id);
      const sections = await getSections(book.id);
      // Whether the highest-index section is still open or already closed,
      // the next genuinely new section always needs an index past all
      // existing ones — reusing the open section's own index here would
      // silently overwrite it instead of creating a new row.
      const nextSectionIndex = sections.length > 0 ? Math.max(...sections.map((s) => s.index)) + 1 : 0;
      const result = await importPdfIncremental(book.id, data, {
        startPage: book.importedUntil + 1,
        startChunkIndex: book.totalChunks,
        nextSectionIndex,
        openSection,
        onProgress: ({ page, totalPages, chunksSoFar }) => {
          void (async () => {
            const updated = await getBook(book.id);
            if (updated) {
              callbacks.onProgress?.(updated, { page, totalPages, chunksSoFar, percent: Math.round((page / totalPages) * 100), playable: true });
            }
          })();
        },
      });
      done = await updateBook(book.id, {
        importStatus: "done",
        importStage: "done",
        importProgress: 100,
        totalChunks: result.totalChunks,
        totalSections: result.totalSections,
      });
    } else {
      const result = await importEpubIncremental(book.id, data, {
        startSpineIndex: book.importedUntil,
        startSectionIndex: book.totalSections,
        startChunkIndex: book.totalChunks,
        onProgress: ({ spineIndex, totalSpineItems, chunksSoFar }) => {
          void (async () => {
            const updated = await getBook(book.id);
            if (updated) {
              callbacks.onProgress?.(updated, {
                page: spineIndex,
                totalPages: totalSpineItems,
                chunksSoFar,
                percent: Math.round((spineIndex / totalSpineItems) * 100),
                playable: true,
              });
            }
          })();
        },
      });
      done = await updateBook(book.id, {
        importStatus: "done",
        importStage: "done",
        importProgress: 100,
        totalChunks: result.totalChunks,
        totalSections: result.totalSections,
      });
    }

    await deleteFileBlob(book.id);
    const finished = done ?? book;
    callbacks.onDone?.(finished);
    return finished;
  } catch (err) {
    const message = err instanceof Error ? err.message : "No se pudo reanudar la importación.";
    const failed = await updateBook(book.id, { importStatus: "error", importStage: "extracting", errorMessage: message });
    callbacks.onError?.(message, "extracting");
    return failed ?? book;
  }
}

export function beginResume(book: BookRecord, callbacks: ImportCallbacks): void {
  void runResume(book, callbacks);
}
