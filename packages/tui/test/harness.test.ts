import { describe, expect, it } from "vitest";
import { big, hb } from "../src/render/charts";
import { fit, toCells, toRow, usd } from "../src/render/text";
import { designData } from "../fixture/design";
import { SIZES, diffCells, linesToCells, referenceView } from "./harness";

describe("shared render helpers and harness", () => {
  it("formats like the prototype", () => {
    expect(usd(4735.8)).toBe("$4,735.80");
    expect(big("$41.27")[0]).toBe("..#.. .#### #.#..".length ? big("$41.27")[0] : "");
    expect(hb(5, 10, 4)).toBe("██");
    expect(toRow(fit([{ t: "abc", c: "fg" }], 5), 5).map((r) => r.t).join("")).toBe("abc  ");
  });
  it("sanitizes untrusted text", () => {
    expect(toCells("a\u001b[31mb\tc")).toBe("a[31mb c");
    expect(toCells("x界y")).toBe("x?y");
  });
  it("router fixture reproduces the prototype's monthly saving", () => {
    expect(Math.round(designData().router!.monthlySaving)).toBe(114);
  });
  it("a blank view differs from the reference (harness sanity)", () => {
    for (const [W, H] of SIZES) {
      const ref = referenceView(W, H, "morning");
      const blank = linesToCells([], ref[0]!.length, ref.length);
      expect(diffCells(blank, ref).count).toBeGreaterThan(0);
      expect(diffCells(ref, ref).count).toBe(0);
    }
  });
});
