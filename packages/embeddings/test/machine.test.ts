import { describe, expect, it } from "vitest";
import { embeddingSeconds, embeddingThreads, machineIsSmall, memoryFits } from "../src/machine";
import { BGE_M3, MINILM } from "../src/model";

const GB = 1e9;

describe("machine limits", () => {
  it("uses the cores up to four, or what REFLEX_EMBED_THREADS asks for", () => {
    expect(embeddingThreads({}, 1)).toBe(1);
    expect(embeddingThreads({}, 2)).toBe(2);
    expect(embeddingThreads({}, 16)).toBe(4);
    expect(embeddingThreads({ REFLEX_EMBED_THREADS: "8" }, 16)).toBe(8);
    expect(embeddingThreads({ REFLEX_EMBED_THREADS: "zero" }, 16)).toBe(4);
  });

  it("refuses a model the machine has no room for, with headroom for everything else", () => {
    expect(memoryFits(BGE_M3, 16 * GB)).toBe(true);
    expect(memoryFits(BGE_M3, 8 * GB)).toBe(true);
    expect(memoryFits(BGE_M3, 4 * GB)).toBe(false);
    expect(memoryFits(MINILM, 4 * GB)).toBe(true);
  });

  it("calls a machine small below 8 GB or 4 cores", () => {
    expect(machineIsSmall(16 * GB, 8)).toBe(false);
    expect(machineIsSmall(8 * GB, 4)).toBe(false);
    expect(machineIsSmall(8 * GB, 2)).toBe(true);
    expect(machineIsSmall(4 * GB, 8)).toBe(true);
  });

  it("estimates embedding time from the measured per-session cost and the threads", () => {
    expect(embeddingSeconds(BGE_M3, 100, 1)).toBeCloseTo(285);
    expect(embeddingSeconds(BGE_M3, 100, 4)).toBeCloseTo(285 / 3.49);
    expect(embeddingSeconds(MINILM, 100, 1)).toBeLessThan(10);
  });
});
