import { describe, expect, it } from "vitest";
import { embedWithinBudget } from "../src/embeddings";
import { duration, parseEmbedMinutes } from "../src/commands/scan";

const items = (n: number) => Array.from({ length: n }, (_, i) => [`k${i}`, `doc ${i}`] as [string, string]);
const fake = (clock: { t: number }, msPerDoc: number) => async (docs: string[]) => {
  clock.t += docs.length * msPerDoc;
  return docs.map(() => Float32Array.of(1));
};

describe("embedding within a time budget", () => {
  it("embeds everything when there is time, saving as it goes", async () => {
    const clock = { t: 0 };
    const saved: string[] = [];
    const done = await embedWithinBudget(items(10), fake(clock, 100), (e) => saved.push(...e.map(([k]) => k)), 60_000, undefined, () => clock.t);
    expect(done).toBe(10);
    expect(saved).toEqual(items(10).map(([k]) => k));
  });

  it("stops at the budget and keeps what it finished; the rest wait for the next call", async () => {
    const clock = { t: 0 };
    const saved: string[] = [];
    const progress: Array<[number, number]> = [];
    const done = await embedWithinBudget(
      items(100),
      fake(clock, 1_000),
      (e) => saved.push(...e.map(([k]) => k)),
      10_000,
      (d, total) => progress.push([d, total]),
      () => clock.t,
    );
    expect(done).toBe(12); // three chunks of four reach 12 s, past the 10 s budget
    expect(saved).toHaveLength(12);
    expect(progress.at(-1)).toEqual([12, 100]);
  });

  it("always makes some progress, even with no time", async () => {
    const clock = { t: 0 };
    expect(await embedWithinBudget(items(10), fake(clock, 1_000), () => undefined, 0, undefined, () => clock.t)).toBe(4);
  });

  it("estimates the time left from the pace so far", async () => {
    const clock = { t: 0 };
    let eta: number | undefined;
    await embedWithinBudget(items(8), fake(clock, 500), () => undefined, 60_000, (d, _t, e) => d === 4 && (eta = e), () => clock.t);
    expect(eta).toBeCloseTo(2); // four left at half a second each
  });
});

describe("scan options", () => {
  it("reads --embed-minutes and formats durations", () => {
    expect(parseEmbedMinutes("5")).toBe(5);
    expect(() => parseEmbedMinutes("-1")).toThrow(/embed-minutes/);
    expect(duration(12)).toBe("12 s");
    expect(duration(300)).toBe("5 min");
    expect(duration(4_800)).toBe("1 h 20 min");
  });
});
