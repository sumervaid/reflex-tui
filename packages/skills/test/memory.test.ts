import { describe, expect, it } from "vitest";
import { MEMORY_END, MEMORY_START, applyMemoryBlock, cleanMemoryText, renderMemoryBlock } from "../src/memory";

const block = renderMemoryBlock([{ text: "Use pnpm, not npm.", sessions: 4 }]);

describe("agent memory block", () => {
  it("appends to an existing file and removes cleanly, byte for byte", () => {
    const mine = "# My rules\n\nAlways write tests.\n";
    const withBlock = applyMemoryBlock(mine, block);
    expect(withBlock.startsWith(mine)).toBe(true);
    expect(withBlock).toContain(MEMORY_START);
    expect(withBlock).toContain("- Use pnpm, not npm. (4 sessions)");
    expect(applyMemoryBlock(withBlock, null)).toBe(mine);
  });

  it("replaces only its own block and keeps text after it", () => {
    const file = `top\n\n${block}\nbottom\n`;
    const next = applyMemoryBlock(file, renderMemoryBlock([{ text: "Keep the ledger schema.", sessions: 2 }]));
    expect(next.startsWith("top\n\n")).toBe(true);
    expect(next.endsWith("\nbottom\n")).toBe(true);
    expect(next).not.toContain("pnpm");
    expect(next.split(MEMORY_START).length).toBe(2);
    expect(next.split(MEMORY_END).length).toBe(2);
  });

  it("creates a file with only the block and is idempotent", () => {
    const once = applyMemoryBlock("", block);
    expect(once).toBe(block + "\n");
    expect(applyMemoryBlock(once, block)).toBe(once);
    expect(applyMemoryBlock("", null)).toBe("");
  });

  it("refuses secrets and strips markers and line breaks from added text", () => {
    expect(cleanMemoryText("use the key sk-ant-api03-" + "a".repeat(40))).toBeUndefined();
    expect(cleanMemoryText("a <!-- reflex:memory:end --> b\nc")).toBe("a reflex:memory:end b c");
    expect(cleanMemoryText("   ")).toBeUndefined();
  });
});
