// Full-screen golden: every view at both sizes, composed by the shell on the design fixture, equals
// the prototype's own output (test/golden/reference-WxH.json) cell for cell.
import { describe, expect, it } from "vitest";
import { designData, designUi } from "../fixture/design";
import { compose } from "../src/shell";
import { VIEW_ORDER } from "../src/types";
import { SIZES, diffCells, referenceCells, rowCells } from "./harness";

describe("full-screen golden", () => {
  for (const [W, H] of SIZES) {
    for (const view of VIEW_ORDER) {
      it(`${view} ${W}x${H}`, () => {
        const frame = compose(W, H, designData(), designUi(view));
        const d = diffCells(frame.rows.map(rowCells), referenceCells(W, H, view));
        expect(d.count, `${view} ${W}x${H}: ${d.count} cells differ\n${d.report}`).toBe(0);
      });
    }
  }
});
