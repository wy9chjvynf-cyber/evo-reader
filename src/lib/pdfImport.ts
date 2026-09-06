import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { splitIntoChunks } from "./chunk";
import { putChunksBatch, putSection, updateBook, type ChunkRecord } from "./db";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export interface PdfImportProgress {
  page: number;
  totalPages: number;
  chunksSoFar: number;
}

interface PdfImportOptions {
  /** 1-based page to start from — > 1 when resuming an interrupted import. */
  startPage: number;
  /** Next chunk index to assign — book.totalChunks when resuming. */
  startChunkIndex: number;
  onProgress: (progress: PdfImportProgress) => void;
}

const devLog = import.meta.env.DEV ? console.debug : () => {};

/**
 * Processes a PDF page by page: extract -> chunk -> persist -> release.
 * Never holds more than one page's text/chunks in memory at a time, and
 * commits after every page so an interrupted import can resume from
 * `book.importedUntil + 1` instead of restarting or losing prior pages.
 */
export async function importPdfIncremental(
  bookId: string,
  data: ArrayBuffer,
  { startPage, startChunkIndex, onProgress }: PdfImportOptions,
): Promise<{ totalPages: number; totalChunks: number }> {
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const totalPages = doc.numPages;
  let chunkIndex = startChunkIndex;

  try {
    for (let pageNum = startPage; pageNum <= totalPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
      page.cleanup();

      const pageChunks = splitIntoChunks(pageText);
      const records: ChunkRecord[] = pageChunks.map((text, i) => ({
        bookId,
        index: chunkIndex + i,
        sectionIndex: pageNum - 1,
        sourcePage: pageNum,
        text,
      }));

      await putChunksBatch(records);
      await putSection({ bookId, index: pageNum - 1, title: null, pageStart: pageNum, pageEnd: pageNum });
      chunkIndex += records.length;

      await updateBook(bookId, { importedUntil: pageNum, totalChunks: chunkIndex, totalPages });

      onProgress({ page: pageNum, totalPages, chunksSoFar: chunkIndex });
      devLog(`[pdfImport] page ${pageNum}/${totalPages}: +${records.length} chunks (total ${chunkIndex})`);
    }
  } finally {
    await doc.cleanup();
  }

  return { totalPages, totalChunks: chunkIndex };
}
