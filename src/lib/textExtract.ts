import mammoth from "mammoth";
import type { BookFormat } from "./db";

export function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^./]+$/, "");
}

export function detectFormat(filename: string): BookFormat | null {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "txt") return "txt";
  if (ext === "docx") return "docx";
  return null;
}

/** Whole-document extraction for formats that don't have a "page" concept to stream over. */
export async function extractFullText(file: File, format: "txt" | "docx"): Promise<string> {
  if (format === "txt") return file.text();
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}
