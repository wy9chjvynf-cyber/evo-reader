/** Very small, deliberately non-exhaustive Markdown helpers — just enough to
 * find `#`/`##`/`###` headings and make the body read naturally aloud. */

const HEADING_RE = /^(#{1,3})\s+(.+?)\s*#*\s*$/;

export interface MarkdownHeading {
  level: number;
  title: string;
}

export function matchMarkdownHeading(line: string): MarkdownHeading | null {
  const match = line.match(HEADING_RE);
  if (!match) return null;
  return { level: match[1].length, title: stripMarkdownSyntax(match[2]) };
}

/** Strips common inline Markdown syntax so narration doesn't read out symbols. */
export function stripMarkdownSyntax(text: string): string {
  return text
    .replace(/!\[[^\]]*]\([^)]*\)/g, "") // images
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1") // links -> visible text
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1") // inline code / fences
    .replace(/(\*\*\*|___)([^*_]+)\1/g, "$2") // bold+italic
    .replace(/(\*\*|__)([^*_]+)\1/g, "$2") // bold
    .replace(/(\*|_)([^*_]+)\1/g, "$2") // italic
    .replace(/^>\s?/gm, "") // blockquote markers
    .replace(/^[-*+]\s+/gm, "") // list bullets
    .replace(/^\d+\.\s+/gm, "") // ordered list markers
    .trim();
}
