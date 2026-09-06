import { describe, expect, it } from "vitest";
import { estimateRemainingLabel } from "../timeEstimate";

describe("estimateRemainingLabel", () => {
  it("returns null when there isn't enough information yet", () => {
    expect(estimateRemainingLabel(0, 100, 0, 1)).toBeNull();
    expect(estimateRemainingLabel(1000, 0, 0, 1)).toBeNull();
    expect(estimateRemainingLabel(1000, 100, 0, 0)).toBeNull();
  });

  it("shrinks as the reader advances through the book", () => {
    const atStart = estimateRemainingLabel(15000, 100, 0, 1)!;
    const atHalf = estimateRemainingLabel(15000, 100, 50, 1)!;
    const atEnd = estimateRemainingLabel(15000, 100, 100, 1)!;
    expect(atStart).not.toBe(atHalf);
    expect(atEnd).toMatch(/menos de 1 min/);
  });

  it("shrinks the estimate as playback rate increases", () => {
    const at1x = estimateRemainingLabel(15000, 100, 0, 1)!;
    const at2x = estimateRemainingLabel(15000, 100, 0, 2)!;
    // Parse the leading number out of "~X h Y min" / "~X min" to compare magnitude.
    const minutesOf = (label: string) => {
      const h = /([\d]+)\s*h/.exec(label);
      const m = /([\d]+)\s*min/.exec(label);
      return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
    };
    expect(minutesOf(at2x)).toBeLessThan(minutesOf(at1x));
  });
});
