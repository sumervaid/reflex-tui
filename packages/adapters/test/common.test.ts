import { describe, expect, it } from "vitest";
import { clean } from "../src/common";

describe("clean", () => {
  const token = "Ab1" + "x9Yz".repeat(15);

  it("never keeps part of a secret that crosses a length limit", () => {
    for (const [kind, max] of [["request", 2000], ["command", 600], ["assistant", 400], ["path", 400]] as const) {
      const text = "a".repeat(max - 20) + " " + token;
      const out = clean[kind](text);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out).not.toContain(token.slice(0, 19));
    }
  });
});
