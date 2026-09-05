import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import mammoth from "mammoth";

// pdfjs-dist and mammoth are imported statically (not via dynamic import())
// on purpose: a dynamic import fetches a separate, content-hashed chunk file
// on demand, and a client that has had the page open across a deploy can end
// up requesting a chunk hash that no longer exists on the server ("Importing
// a module script failed"). Bundling them into the main chunk means the code
// is already in memory by the time a file is picked, regardless of what the
// server currently has deployed. The one fetch that's still unavoidable —
// the pdf.js worker script, which must be a real separate file — is guarded
// against the same problem by keeping old deploys' assets on the server (see
// scripts/deploy.sh).
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

async function extractPdf(file: File): Promise<string> {
  const data = await file.arrayBuffer();

  let doc: Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
  try {
    doc = await pdfjsLib.getDocument({ data }).promise;
  } catch (err) {
    throw new Error(
      "No se pudo iniciar el lector de PDF. Si la app se actualizó recientemente, recarga la página e inténtalo de nuevo.",
      { cause: err },
    );
  }

  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push(text);
  }
  return pages.join("\n\n");
}

async function extractDocx(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

export function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^./]+$/, "");
}

export async function extractText(file: File): Promise<string> {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "txt") return file.text();
  if (ext === "pdf") return extractPdf(file);
  if (ext === "docx") return extractDocx(file);
  throw new Error("Formato no soportado. Usa PDF, TXT o DOCX.");
}
