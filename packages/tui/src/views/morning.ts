import type { Bar, Item, ItemState, TuiData } from "../model";
import { big, hbars, vchart } from "../render/charts";
import { BOLD, S, fmt, hcat, rp, tr, usd } from "../render/text";
import type { ColorToken, Line, UiState, ViewOut } from "../types";

// Port of the prototype's `morning(w, h, st)` (docs/design/tui-v5/reference, script block). The
// arithmetic, rounding and segment order are the prototype's; the mock constants come from TuiData.

const SCOL: Record<Exclude<ItemState, "">, ColorToken> = { new: "ok", updated: "warn", retired: "bad" };
const NOT_MEASURED = "not measured yet";

/** Token counts as the design writes them: "18.4M", "312k". */
function tok(n: number): string {
  if (n >= 999_950) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(Math.round(n));
}

/** A bar list, or its title and "not measured yet" when there is nothing measured. */
function bars(title: string, list: Bar[] | undefined, w: number, nw: number): Line[] {
  if (!list?.length) return [[S(title, "hi", BOLD)], [S(NOT_MEASURED, "dim")]];
  return hbars(
    title,
    list.map((b): [string, number] => [b.name, b.usd]),
    w,
    { nw },
  );
}

/** Morning: yesterday's cost against the 7-day average, where it went, what changed in skills, workflows and the router. */
export function renderMorning(w: number, h: number, data: TuiData, _ui: UiState): ViewOut {
  const yd = data.yesterday;
  const money = data.money;
  const head: Line = [S("YESTERDAY", "dim", BOLD), ...(yd ? [S("   " + yd.label, "dim")] : [])];
  const facts: Line[] = [];
  if (yd)
    facts.push([
      S(fmt(yd.sessions), "hi"),
      S(" sessions    ", "dim"),
      S(tok(yd.contextTokens), "hi"),
      S(" context    ", "dim"),
      S(tok(yd.outputTokens), "hi"),
      S(" output tokens", "dim"),
    ]);
  facts.push(
    money
      ? [S("all time ", "dim"), S(usd(money.allTime.usd), "hi", BOLD), S(" since " + money.allTime.since + "    this month ", "dim"), S(usd(money.month.usd), "fg")]
      : [S("all time ", "dim"), S("—", "dim"), S("    this month ", "dim"), S("—", "dim")],
  );

  // The hero needs the cost of yesterday and the 7 days before it.
  const last8 = (data.days ?? []).slice(-8);
  const cost = last8.map((d) => d.usd);
  let L: Line[];
  if (cost.length === 8 && cost.every((v) => v != null)) {
    const u = cost as number[];
    const y = u[7]!;
    const avg = u.slice(0, 7).reduce((a, v) => a + v, 0) / 7;
    const dp = (y / avg - 1) * 100;
    const up = dp > 0;
    const dc: ColorToken = up ? "warn" : "ok";
    const cw = w >= 140 ? 5 : 4;
    const chartW = 8 * cw + 6;
    const lw = w - chartW - 6;
    const bu = big(usd(y));
    const bp = big(avg > 0 ? (up ? "+" : "-") + Math.abs(Math.round(dp)) + "%" : "");
    const left: Line[] = [
      head,
      [],
      ...bu.map((t, i): Line => [S(t, "hi"), S("    "), S(bp[i] ?? "", dc)]),
      [],
      [S(up ? "above" : "below", "fg"), S(" your 7-day average of ", "dim"), S(usd(avg), "fg"), S(" by ", "dim"), S(usd(Math.abs(y - avg)), dc, BOLD)],
      ...facts,
    ];
    const mx = Math.max(...u);
    const base = Math.floor((Math.min(...u) * 0.8) / 5) * 5;
    const span = mx - base || 1;
    const cr = h >= 40 ? 8 : 6;
    const avgRow = cr - 1 - Math.min(cr - 1, Math.floor(((avg - base) / span) * cr));
    const axis = (r: number): string =>
      r === 0 ? rp("$" + Math.round(mx), 5) + " " : r === avgRow ? rp("$" + Math.round(avg), 5) + " " : r === cr - 1 ? rp("$" + base, 5) + " " : "      ";
    const ch = vchart(
      u.map((v) => v - base),
      cr,
      cw,
      (_v, i) => (i === 7 ? dc : "faint"),
      { line: avg - base, max: span, axis },
    );
    const right: Line[] = [
      [S("      last 8 days", "dim"), S("   ╌ 7-day avg", "faint")],
      ...ch,
      [S("      "), ...last8.map((d, i) => S(tr(i === 7 ? "yday" : d.label.slice(0, 2), cw), i === 7 ? "hi" : "dim"))],
    ];
    L = hcat(
      [
        { lines: left, w: lw },
        { lines: right, w: chartW },
      ],
      6,
    );
  } else L = [head, [S(NOT_MEASURED, "dim")], [], ...facts];
  L.push([]);

  const t3 = Math.floor((w - 8) / 3);
  L.push(
    ...hcat(
      [
        { lines: bars("by cli tool", yd?.byTool, t3, 8), w: t3 },
        { lines: bars("by model", yd?.byModel?.slice(0, 5), t3, 11), w: t3 },
        { lines: bars("by project", yd?.byProject?.slice(0, 5), w - 2 * t3 - 8, 11), w: w - 2 * t3 - 8 },
      ],
      4,
    ),
  );
  L.push([]);

  const all: Array<{ k: "skill" | "wf"; x: Item }> = [
    ...data.skills.items.map((x) => ({ k: "skill" as const, x })),
    ...(data.workflows?.items ?? []).map((x) => ({ k: "wf" as const, x })),
  ];
  const tail = 4;
  const cap = Math.max(2, Math.min(8, h - L.length - tail - 3));
  const cw3 = Math.floor((w - 6) / 3);
  const col = (k: Exclude<ItemState, "">): Line[] => {
    const xs = all.filter((e) => e.x.state === k);
    const c = SCOL[k];
    const o: Line[] = [[S(String(xs.length), c, BOLD), S(" " + k.toUpperCase(), c, BOLD)], [S("━".repeat(Math.max(0, cw3)), c)]];
    xs.slice(0, cap).forEach((e) =>
      o.push([S(e.k.padEnd(6), "dim"), S(tr((e.k === "wf" ? (data.workflows?.runAs ?? "") : "") + e.x.name, cw3 - 16), "fg"), S(rp(e.x.support + " sess", 10), "dim")]),
    );
    if (xs.length > cap) o.push([S("      +" + (xs.length - cap) + " more", "dim")]);
    return o;
  };
  L.push(
    ...hcat(
      [
        { lines: col("new"), w: cw3 },
        { lines: col("updated"), w: cw3 },
        { lines: col("retired"), w: w - 2 * cw3 - 6 },
      ],
      3,
    ),
  );
  L.push([]);

  const rl: Line = [S("ROUTER  ", "dim", BOLD)];
  if (!data.router) rl.push(S(NOT_MEASURED, "dim"));
  else
    data.router.tasks
      .filter((t) => t.previous && t.previous !== t.rec)
      .forEach((t, i) => {
        if (i) rl.push(S("     "));
        rl.push(S(t.key + "  ", "hi"), S(t.previous ?? "", "dim"), S(" -> ", "dim"), S(t.rec, "ok"));
      });
  L.push(rl);

  const al: Line = [S("ACTIVE  ", "dim", BOLD), S(data.skills.items.filter((x) => x.on).length + " skills", "hi")];
  if (data.workflows?.runAs) al.push(S(" + ", "dim"), S(data.workflows.items.filter((x) => x.on).length + " workflows", "hi"));
  if (data.activeDirs.length) al.push(S("  in " + data.activeDirs.join("  "), "dim"));
  L.push(al);
  const mem = data.memory;
  if (mem) {
    const ml: Line = [S("MEMORY  ", "dim", BOLD), S(mem.enabled ? "on" : "off", mem.enabled ? "ok" : "dim", BOLD), S(` · ${mem.entries.length} remembered`, "hi")];
    if (mem.enabled && mem.files.length) ml.push(S("  in " + mem.files.join("  "), "dim"));
    else if (!mem.enabled && mem.entries.length) ml.push(S("  press m to share with new agent sessions", "dim"));
    if (mem.entries[0]) ml.push(S(`  · "${mem.entries[0].text}"`, "dim"));
    L.push(ml);
  }

  const dl: Line = [S("DATA    ", "dim", BOLD), S(data.dataDir, "fg")];
  if (data.reads.length) dl.push(S("  reads " + data.reads.join("  "), "dim"));
  L.push(dl);

  return { lines: L.slice(0, Math.max(0, h)), hits: [] };
}
