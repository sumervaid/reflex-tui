import { describe, expect, it } from "vitest";
import type { WorkflowTrace } from "@reflex/core";
import { FULL_AT, LEARN_FROM, fillerWeights } from "../src/fillers";

// Three kinds of work with different behavior; "basically" appears in all of them, "slugify" only in one.
const KINDS: string[][] = [
  ["inspect-ci", "install-dependencies", "modify-config", "run-tests"],
  ["inspect-code", "modify-code", "run-build", "inspect-diff"],
  ["inspect-repository", "modify-tests", "run-lint"],
];
function history(n: number): Pick<WorkflowTrace, "intents" | "actionSequence">[] {
  return Array.from({ length: n }, (_, i) => ({
    actionSequence: KINDS[i % 3] as WorkflowTrace["actionSequence"],
    intents: ["basically", ...(i % 3 === 1 ? ["slugify"] : []), ...(i % 2 ? ["ci"] : [])],
  }));
}

describe("learned filler words", () => {
  it("learns nothing from a short history", () => {
    expect(fillerWeights(history(LEARN_FROM - 1)).size).toBe(0);
  });

  it("quiets a word used across unrelated kinds of work, not one tied to a behavior", () => {
    const w = fillerWeights(history(FULL_AT));
    expect(w.get("basically")).toBeCloseTo(0.2);
    expect(w.has("slugify")).toBe(false);
  });

  it("never quiets developer words, however widely they are used", () => {
    expect(fillerWeights(history(FULL_AT)).has("ci")).toBe(false);
  });

  it("grows stronger as the history grows", () => {
    const small = fillerWeights(history(40)).get("basically")!;
    const large = fillerWeights(history(150)).get("basically")!;
    expect(small).toBeGreaterThan(large);
    expect(small).toBeLessThan(1);
  });
});
