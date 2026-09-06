import mammoth from "mammoth";
import type { DocumentSegment } from "./sectionBuilder";

const HEADING_TAGS = new Set(["h1", "h2", "h3"]);

/**
 * Mammoth's default style map already turns Word's built-in "Heading 1/2/3"
 * paragraph styles into <h1>/<h2>/<h3> when converting to HTML (no custom
 * styleMap needed). Walking that HTML in order and splitting at heading
 * elements gives real chapter structure for well-formed manuscripts, while a
 * document with no headings falls back to a single whole-document section —
 * never blocked on formatting.
 */
export async function extractDocxSegments(file: File): Promise<DocumentSegment[]> {
  const arrayBuffer = await file.arrayBuffer();
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer });
  const doc = new DOMParser().parseFromString(html, "text/html");

  const segments: DocumentSegment[] = [];
  let currentTitle: string | null = null;
  let currentLevel = 1;
  let currentText: string[] = [];
  let sawAnyHeading = false;

  const flush = () => {
    const text = currentText.join("\n").trim();
    if (text || currentTitle) {
      segments.push({ title: currentTitle, level: currentLevel, sourceType: "heading", sourceStart: null, sourceEnd: null, text });
    }
    currentText = [];
  };

  for (const node of Array.from(doc.body.children)) {
    const tag = node.tagName.toLowerCase();
    if (HEADING_TAGS.has(tag)) {
      flush();
      currentTitle = node.textContent?.trim() || null;
      currentLevel = Number(tag[1]);
      sawAnyHeading = true;
      continue;
    }
    const text = node.textContent?.trim();
    if (text) currentText.push(text);
  }
  flush();

  if (!sawAnyHeading) {
    // The loop above already accumulated all paragraphs, newline-separated, into one segment.
    return segments.map((s) => ({ ...s, sourceType: "whole" }));
  }
  return segments;
}
