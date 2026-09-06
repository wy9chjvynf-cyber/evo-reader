import { matchHeadingLine } from "./chapterHeuristics";
import { matchMarkdownHeading, stripMarkdownSyntax } from "./markdown";
import type { DocumentSegment } from "./sectionBuilder";
import type { SectionRecord } from "./db";

interface HeadingHit {
  title: string;
  level: number;
  linesConsumed: number;
}

type LineHeadingMatcher = (lines: string[], index: number) => HeadingHit | null;

function buildSegmentsFromLines(fullText: string, matchHeading: LineHeadingMatcher): DocumentSegment[] {
  const lines = fullText.split(/\r\n|\r|\n/);
  const segments: DocumentSegment[] = [];
  let currentTitle: string | null = null;
  let currentLevel = 1;
  let currentLines: string[] = [];
  let sawAnyHeading = false;

  const flush = () => {
    const text = currentLines.join("\n").trim();
    if (text || currentTitle) {
      segments.push({ title: currentTitle, level: currentLevel, sourceType: "heading", sourceStart: null, sourceEnd: null, text });
    }
    currentLines = [];
  };

  let i = 0;
  while (i < lines.length) {
    const hit = matchHeading(lines, i);
    if (hit) {
      flush();
      currentTitle = hit.title;
      currentLevel = hit.level;
      i += hit.linesConsumed;
      sawAnyHeading = true;
      continue;
    }
    currentLines.push(lines[i]);
    i += 1;
  }
  flush();

  if (!sawAnyHeading) {
    // No headings anywhere — one general section, but the book stays fully legible.
    return [{ title: null, level: 1, sourceType: "whole" as SectionRecord["sourceType"], sourceStart: null, sourceEnd: null, text: fullText }];
  }
  return segments;
}

const MAX_TITLE_CONTINUATION_LENGTH = 40;

/** TXT: conservative CAPÍTULO/PRÓLOGO/EPÍLOGO/INTRODUCCIÓN detection, same heuristic as PDF. */
export function buildTxtSegments(fullText: string): DocumentSegment[] {
  return buildSegmentsFromLines(fullText, (lines, i) => {
    const match = matchHeadingLine(lines[i]);
    if (!match) return null;
    if (!match.needsNextLine) return { title: match.title, level: 1, linesConsumed: 1 };

    const next = lines[i + 1]?.trim();
    if (next && next.length <= MAX_TITLE_CONTINUATION_LENGTH && !/[.!?,;]$/.test(next) && !matchHeadingLine(next)) {
      return { title: `${match.title} — ${next}`, level: 1, linesConsumed: 2 };
    }
    return { title: match.title, level: 1, linesConsumed: 1 };
  });
}

/** Markdown: `#`/`##`/`###` headings. */
export function buildMarkdownSegments(fullText: string): DocumentSegment[] {
  const segments = buildSegmentsFromLines(fullText, (lines, i) => {
    const match = matchMarkdownHeading(lines[i]);
    if (!match) return null;
    return { title: match.title, level: match.level, linesConsumed: 1 };
  });
  return segments.map((s) => ({ ...s, text: stripMarkdownSyntax(s.text) }));
}
