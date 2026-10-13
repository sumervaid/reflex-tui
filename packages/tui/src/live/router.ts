import { ROUTE_MARGIN as MARGIN, ROUTE_MIN_SUPPORT as MIN_SUPPORT, friction as traceFriction } from "@reflex/analysis";
import type { ModelEvidence, Router, RouterTask } from "../model";
import { toCells } from "../render/text";
import { type Priced, taskKind } from "./costs";
import { dayLabel } from "./labels";

const friction = (p: Priced): number => traceFriction(p.t);
/** Sessions listed under the selected row. */
const RECENT = 5;

/** The model that cost the most in a session: the one it mostly ran on. */
const mainModel = (p: Priced): string | undefined => Object.entries(p.byModel).sort((a, b) => b[1] - a[1])[0]?.[0];

/**
 * For each kind of task, the models you used on it, what a session cost on each and how often it
 * needed fixing. The pick is the cheapest model with enough sessions that needed fixing about as
 * rarely as the best one. Autopilot means `reflex run` starts on the pick without asking.
 * Undefined when no session has a priced model.
 */
export function buildRouter(priced: Priced[], rebuiltAt: string, windowDays: number, autopilot = false): Router | undefined {
  const rows = priced.flatMap((p) => {
    const model = mainModel(p);
    return model && p.cost ? [{ p, model, kind: taskKind(p.t) }] : [];
  });
  if (!rows.length) return undefined;
  const kinds = new Map<string, { name: string; rows: typeof rows }>();
  for (const r of rows) kinds.set(r.kind.key, { name: r.kind.name, rows: [...(kinds.get(r.kind.key)?.rows ?? []), r] });

  const tasks: RouterTask[] = [];
  let monthlySaving = 0;
  let movedSessions = 0;
  for (const [key, { name, rows: rs }] of kinds) {
    const models = new Map<string, Priced[]>();
    for (const r of rs) models.set(r.model, [...(models.get(r.model) ?? []), r.p]);
    const evidence: ModelEvidence[] = [...models].map(([model, ps]) => ({
      model: toCells(model),
      sessions: ps.length,
      usd: ps.reduce((a, p) => a + p.cost!.usd, 0) / ps.length,
      friction: ps.reduce((a, p) => a + friction(p), 0) / ps.length,
    }));
    evidence.sort((a, b) => b.sessions - a.sessions || a.usd - b.usd);
    const most = evidence[0]!;
    const eligible = evidence.filter((e) => e.sessions >= MIN_SUPPORT);
    const best = Math.min(...(eligible.length ? eligible : evidence).map((e) => e.friction));
    const rec = eligible.filter((e) => e.friction <= best + MARGIN).sort((a, b) => a.usd - b.usd)[0] ?? most;
    const save = Math.max(0, most.usd - rec.usd);
    if (rec.model !== most.model) {
      monthlySaving += (save * most.sessions * 30) / Math.max(1, windowDays);
      movedSessions += most.sessions;
    }
    const recent = [...rs]
      .sort((a, b) => b.p.at - a.p.at)
      .slice(0, RECENT)
      .map((r) => ({
        date: r.p.at ? dayLabel(new Date(r.p.at)) : "—",
        project: toCells(r.p.t.projectName ?? "—"),
        model: toCells(r.model),
        usd: r.p.cost!.usd,
        friction: friction(r.p),
        prompt: toCells(r.p.t.excerpt),
      }));
    tasks.push({ key, name, evidence, rec: rec.model, most: most.model, mostSessions: most.sessions, save, sessions: rs.length, best, recent });
  }
  tasks.sort((a, b) => b.sessions - a.sessions);
  return {
    autopilot,
    sessions: rows.length,
    rebuiltAt,
    policyFile: `built in: ${MIN_SUPPORT}+ sessions per model, within ${MARGIN} fixes per reply of the best`,
    minSupport: MIN_SUPPORT,
    margin: MARGIN,
    monthlySaving,
    movedSessions,
    tasks,
  };
}
