import { describe, expect, it } from "vitest";
import { clean, errorExcerpt, textContent } from "../src/common";

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

describe("errorExcerpt", () => {
  it("keeps the first 200 characters, redacted", () => {
    const out = errorExcerpt("Error: cannot find module 'left-pad'  NPM_TOKEN=npm_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8\n    at run (" + "x".repeat(300) + ")");
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(200);
    expect(out).toContain("cannot find module");
    expect(out).not.toContain("npm_a1B2");
  });

  it("is dropped when something the redaction does not cover is still visible", () => {
    // `git@` is excluded from the email redaction on purpose, but an email-shaped leak still fails the gate.
    expect(errorExcerpt("git@github.com: Permission denied (publickey)")).toBeUndefined();
    expect(errorExcerpt(undefined)).toBeUndefined();
    expect(errorExcerpt("   \n  ")).toBeUndefined();
  });
});

describe("textContent", () => {
  it("reads a string or text blocks", () => {
    expect(textContent("plain")).toBe("plain");
    expect(textContent([{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "other" }])).toBe("a\nb\n"); // empty parts keep their separators
    expect(textContent(42)).toBeUndefined();
  });
});
