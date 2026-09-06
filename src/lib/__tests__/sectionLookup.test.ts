import { describe, expect, it } from "vitest";
import { findSectionForChunk } from "../sectionLookup";
import type { SectionRecord } from "../db";

function section(index: number, firstChunkIndex: number | null, lastChunkIndex: number | null): SectionRecord {
  return {
    bookId: "b",
    index,
    title: `Sección ${index}`,
    level: 1,
    sourceType: "heading",
    sourceStart: null,
    sourceEnd: null,
    firstChunkIndex,
    lastChunkIndex,
    wordCount: 0,
  };
}

describe("findSectionForChunk", () => {
  const sections = [section(0, 0, 9), section(1, 10, 24), section(2, 25, 49)];

  it("finds the section containing a chunk index in the middle of the book", () => {
    expect(findSectionForChunk(sections, 15)?.index).toBe(1);
  });

  it("finds the first and last sections correctly", () => {
    expect(findSectionForChunk(sections, 0)?.index).toBe(0);
    expect(findSectionForChunk(sections, 49)?.index).toBe(2);
  });

  it("treats an open (still-importing) last section as covering everything from its start onward", () => {
    const withOpenEnd = [section(0, 0, 9), section(1, 10, null)];
    expect(findSectionForChunk(withOpenEnd, 500)?.index).toBe(1);
  });

  it("falls back to the closest preceding section across a gap", () => {
    const withGap = [section(0, 0, 9), section(1, 20, 29)];
    expect(findSectionForChunk(withGap, 15)?.index).toBe(0);
  });

  it("returns undefined when there are no sections yet", () => {
    expect(findSectionForChunk([], 0)).toBeUndefined();
  });

  it("ignores sections that never got any chunks (firstChunkIndex null)", () => {
    const withEmpty = [section(0, null, null), section(1, 0, 9)];
    expect(findSectionForChunk(withEmpty, 5)?.index).toBe(1);
  });
});
