import type { Item, ItemState, TuiData } from "../model";
import { mdLines } from "../render/charts";
import { BOLD, S, box, hcat, llen, table, type Cell, type Column } from "../render/text";
import type { ColorToken, Hit, Line, UiState, ViewOut } from "../types";

// Port of the prototype's `itemsTab` (docs/design/tui-v5/reference, script block): hint line, then a
// 40% boxed table of items beside a 60% boxed preview of the selected item's markdown.

type Kind = "skills" | "workflows";

const SCOL: Partial<Record<ItemState, ColorToken>> = { new: "ok", updated: "warn", retired: "bad" };

const WIDE_COLS: Column[] = [
  { h: "on", w: 2 },
  { h: "name", flex: true, min: 14 },
  { h: "support", w: 7, r: true },
  { h: "updated", w: 7 },
  { h: "steps", w: 5, r: true },
];
const NARROW_COLS: Column[] = [
  { h: "on", w: 2 },
  { h: "name", flex: true, min: 14 },
  { h: "sup", w: 3, r: true },
  { h: "upd", w: 6 },
  { h: "st", w: 2, r: true },
];

/**
 * `space` and the files it writes. With the design's two targets this is the prototype's copy; when
 * the targets do not fit in `w`, the last ones collapse into "N more".
 */
function hint(kind: Kind, targets: string[], w: number, wide: boolean): Line {
  if (!targets.length) return [];
  const isS = kind === "skills";
  const verb = isS ? (wide ? " toggles the selected skill: installs or removes " : " installs/removes ") : wide ? " toggles the workflow: installs or removes " : " installs ";
  const build = (k: number): Line => {
    const parts: Line[] = targets.slice(0, k).map((t, i) => (isS || i ? [S(t)] : [S(t), S(wide ? " (run as " : " (", "dim"), S("/wf-<name> <task>"), S(")", "dim")]));
    if (k < targets.length) parts.push([S(`${targets.length - k} more`, "dim")]);
    const l: Line = [S("space", "hi", BOLD), S(verb, "dim")];
    parts.forEach((p, i) => {
      if (i) l.push(S(wide ? (i === parts.length - 1 ? " and " : ", ") : " + ", "dim"));
      l.push(...p);
    });
    return l;
  };
  let k = targets.length;
  while (k > 1 && llen(build(k)) > w) k--;
  return build(k);
}

/** Skills or Workflows: the item table (rows select) and the selected item's scrollable preview. */
export function renderItems(kind: Kind, w: number, h: number, data: TuiData, ui: UiState): ViewOut {
  const src = kind === "skills" ? data.skills : data.workflows;
  const list: Item[] = src?.items ?? [];
  const wide = w >= 140;
  const hintLine: Line = src ? hint(kind, src.targets, w, wide) : [S("workflows are not available yet", "dim")];
  const lw = Math.round(w * 0.4);
  const rw = w - lw - 1;
  const bh = h - 2;
  const nOn = list.filter((x) => x.on).length;
  const title = `${kind}  ${list.length} · ${nOn} on`;
  const hits: Hit[] = [];
  let left: Line[];
  let right: Line[];
  if (!list.length) {
    left = box(lw, bh, title, [[S(`no ${kind} yet`, "dim")]]);
    right = box(rw, bh, "preview", []);
  } else {
    const sel = Math.max(0, Math.min(list.length - 1, ui.sel[kind]));
    const rows = list.map((x): Cell[] => [S(x.on ? "●" : "○", x.on ? "ok" : "dim"), S(x.name, SCOL[x.state] ?? "fg"), S(x.support), S(x.updated, x.state ? "fg" : "dim"), S(x.steps)]);
    // The box shows the header plus `vis` rows. A longer list scrolls to keep the selection in view
    // (never at the design sizes, so the prototype's output is unchanged).
    const vis = Math.max(0, bh - 3);
    const first = rows.length > vis ? Math.max(0, Math.min(sel - Math.floor(vis / 2), rows.length - vis)) : 0;
    const shown = rows.slice(first, first + vis);
    left = box(lw, bh, title, table(wide ? WIDE_COLS : NARROW_COLS, shown, lw - 4, { sel: sel - first }), { sub: `${sel + 1}/${list.length}` });
    // View line 0 is the hint, 1 blank, 2 the box top, 3 the table header: row i is line 4 + i.
    shown.forEach((_, i) => hits.push({ x0: 0, x1: lw, y0: 4 + i, y1: 5 + i, action: { type: "select", list: kind, index: first + i } }));
    const x = list[sel]!;
    right = box(rw, bh, x.path, mdLines(x.markdown, rw - 4), { sub: x.on ? "installed" : "not installed", scroll: ui.previewScroll });
  }
  if (bh > 0) hits.push({ x0: lw + 1, x1: lw + 1 + rw, y0: 2, y1: 2 + bh, action: { type: "scroll", pane: "preview" } });
  const body = hcat(
    [
      { lines: left, w: lw },
      { lines: right, w: rw },
    ],
    1,
  );
  return {
    lines: [hintLine, [], ...body],
    hits,
  };
}
