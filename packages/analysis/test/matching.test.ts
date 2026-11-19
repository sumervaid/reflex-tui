import { describe, expect, it } from "vitest";
import { DEFAULT_MATCHING, MAX_SESSIONS, MIN_SESSIONS, describeMatching, learnedMatching, stepMatching, type Decision } from "../src/matching";

const approve = (n: number) => Array<Decision>(n).fill("approved");
const notUseful = (n: number) => Array<Decision>(n).fill("not-useful");
const wrongGrouping = (n: number) => Array<Decision>(n).fill("wrong-grouping");

describe("stepMatching", () => {
  it("moves the strictness thresholds first, and the session count only at their edge", () => {
    expect(stepMatching(DEFAULT_MATCHING, "looser")).toEqual({ sessions: 3, strictness: "looser" });
    expect(stepMatching(DEFAULT_MATCHING, "stricter")).toEqual({ sessions: 3, strictness: "stricter" });
    expect(stepMatching({ sessions: 3, strictness: "looser" }, "looser")).toEqual({ sessions: 2, strictness: "looser" });
    expect(stepMatching({ sessions: 3, strictness: "stricter" }, "stricter")).toEqual({ sessions: 4, strictness: "stricter" });
  });

  it("stops at the floor and the ceiling", () => {
    const floor = { sessions: MIN_SESSIONS, strictness: "looser" } as const;
    const ceiling = { sessions: MAX_SESSIONS, strictness: "stricter" } as const;
    expect(stepMatching(floor, "looser")).toEqual(floor);
    expect(stepMatching(ceiling, "stricter")).toEqual(ceiling);
  });
});

describe("learnedMatching", () => {
  it("needs a few decisions before it moves anything", () => {
    expect(learnedMatching(DEFAULT_MATCHING, approve(4))).toBeUndefined();
  });

  it("goes a step looser when almost everything was approved", () => {
    const learned = learnedMatching(DEFAULT_MATCHING, [...approve(6), ...notUseful(2)])!;
    expect(learned.direction).toBe("looser");
    expect(learned.next).toEqual({ sessions: 3, strictness: "looser" });
    expect(learned.message).toContain("approved 6 of your last 8");
  });

  it("goes a step stricter when wrong-grouping rejections dominate", () => {
    const learned = learnedMatching(DEFAULT_MATCHING, [...wrongGrouping(4), ...approve(1)])!;
    expect(learned.direction).toBe("stricter");
    expect(learned.next).toEqual({ sessions: 3, strictness: "stricter" });
    expect(learned.message).toContain("mixed unrelated tasks");
  });

  it("does not move on a mixed batch, or when rejections were not about grouping", () => {
    expect(learnedMatching(DEFAULT_MATCHING, [...approve(3), ...notUseful(2)])).toBeUndefined();
    expect(learnedMatching(DEFAULT_MATCHING, [...notUseful(5)])).toBeUndefined();
    expect(learnedMatching(DEFAULT_MATCHING, [...approve(3), ...wrongGrouping(2)])).toBeUndefined();
  });

  it("stops at the floor and the ceiling instead of claiming a move", () => {
    expect(learnedMatching({ sessions: MIN_SESSIONS, strictness: "looser" }, approve(5))).toBeUndefined();
    expect(learnedMatching({ sessions: MAX_SESSIONS, strictness: "stricter" }, wrongGrouping(5))).toBeUndefined();
  });
});

describe("describeMatching", () => {
  it("reads as a sentence", () => {
    expect(describeMatching(DEFAULT_MATCHING)).toBe("3 sessions, default matching");
  });
});
