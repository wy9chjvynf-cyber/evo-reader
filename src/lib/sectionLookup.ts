import type { SectionRecord } from "./db";

/** Finds which section a chunk index falls in. Tolerant of an open (still-importing) last section and small gaps. */
export function findSectionForChunk(sections: SectionRecord[], chunkIndex: number): SectionRecord | undefined {
  let best: SectionRecord | undefined;
  for (const s of sections) {
    if (s.firstChunkIndex === null || s.firstChunkIndex === undefined) continue;
    if (s.firstChunkIndex <= chunkIndex && (s.lastChunkIndex === null || s.lastChunkIndex === undefined || chunkIndex <= s.lastChunkIndex)) {
      return s;
    }
    if (s.firstChunkIndex <= chunkIndex && (!best || s.firstChunkIndex > (best.firstChunkIndex ?? -1))) {
      best = s;
    }
  }
  return best;
}
