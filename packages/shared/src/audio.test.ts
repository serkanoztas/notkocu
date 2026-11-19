import { describe, expect, it } from "vitest";
import { chunkStarts, locateChunk, parseClock, toGlobal, totalDuration } from "./audio";

const chunks = [
  { startSec: 0, durationSec: 600 },
  { startSec: 600, durationSec: 600 },
  { startSec: 1200, durationSec: 300 },
];

describe("locateChunk", () => {
  it("finds the piece and the local position", () => {
    expect(locateChunk(chunks, 0)).toEqual({ index: 0, localSec: 0 });
    expect(locateChunk(chunks, 125.5)).toEqual({ index: 0, localSec: 125.5 });
    expect(locateChunk(chunks, 700)).toEqual({ index: 1, localSec: 100 });
  });
  it("opens the NEXT piece exactly on a boundary", () => {
    expect(locateChunk(chunks, 600)).toEqual({ index: 1, localSec: 0 });
    expect(locateChunk(chunks, 1200)).toEqual({ index: 2, localSec: 0 });
    expect(locateChunk(chunks, 599.9)).toEqual({ index: 0, localSec: 599.9 });
  });
  it("clamps before the start and after the end", () => {
    expect(locateChunk(chunks, -5)).toEqual({ index: 0, localSec: 0 });
    expect(locateChunk(chunks, 9999)).toEqual({ index: 2, localSec: 300 });
  });
  it("handles an empty list and a single piece", () => {
    expect(locateChunk([], 10)).toBeNull();
    expect(locateChunk([{ startSec: 0, durationSec: 60 }], 30)).toEqual({ index: 0, localSec: 30 });
  });
  it("uses real (uneven) piece durations", () => {
    const uneven = [
      { startSec: 0, durationSec: 598.4 },
      { startSec: 598.4, durationSec: 601.1 },
    ];
    expect(locateChunk(uneven, 598.4)).toEqual({ index: 1, localSec: 0 });
    expect(locateChunk(uneven, 598.3)?.index).toBe(0);
  });
});

describe("timeline helpers", () => {
  it("builds starts and totals from durations", () => {
    expect(chunkStarts([600, 600, 300])).toEqual([0, 600, 1200]);
    expect(totalDuration(chunks)).toBe(1500);
    expect(totalDuration([])).toBe(0);
  });
  it("converts local to global", () => {
    expect(toGlobal(chunks[1]!, 100)).toBe(700);
  });
  it("parses clock strings", () => {
    expect(parseClock("00:12")).toBe(12);
    expect(parseClock("12:40")).toBe(760);
    expect(parseClock("1:02:03")).toBe(3723);
    expect(parseClock("10:05.5")).toBe(605);
    expect(parseClock("abc")).toBeNull();
    expect(parseClock("12")).toBeNull();
  });
});
