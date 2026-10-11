import type { ModelEvidence, Router, RouterTask } from "../model";
import { toCells } from "../render/text";
import { type Priced, taskKind } from "./costs";

/** A model needs this many sessions of a kind of task before it can be picked. */
const MIN_SUPPORT = 3;
/** A pick may need fixing this much more often (per reply) than the most reliable model. */
const MARGIN = 0.05;

/** How often a session needed fixing: your corrections, failed tool calls and immediately repeated commands, per request you typed. */
function friction(p: Priced): number {
  const cmds = p.t.commands.map((c) => c.normalized);
  const repeats = cmds.filter((c, i) => i > 0 && c === cmds[i - 1]).length;
  return ((p.t.corrections?.length ?? 0) + (p.t.toolErrors ?? 0) + repeats) / Math.max(1, p.t.requests ?? 1);
}

/** The model that cost the most in a session: the one it mostly ran on. */
const mainModel = (p: Priced): string | undefined => Object.entries(p.byModel).sort((a, b) => b[1] - a[1])[0]?.[0];

/**
 * Suggestions only (no autopilot): for each kind of task, the models you used on it, what a session
 * cost on each and how often it needed fixing. The pick is the cheapest model with enough sessions
 * that needed fixing about as rarely as the best one. Undefined when no session has a priced model.
 */
export function buildRouter(priced: Priced[], rebuiltAt: string, windowDays: number): Router | undefined {
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
    tasks.push({ key, name, evidence, rec: rec.model, most: most.model, mostSessions: most.sessions, save, sessions: rs.length, best });
  }
  tasks.sort((a, b) => b.sessions - a.sessions);
  return {
    autopilot: false,
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
