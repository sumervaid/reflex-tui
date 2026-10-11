// FixtureSource: the design fixture as a DataSource, with the prototype's simulated actions (its
// `toggle`, `rescan` and resume toast). Dev and test only; never imported by src/, never shipped.
import type { TuiData } from "../src/model";
import { fmt } from "../src/render/text";
import type { ActionResult, DataSource, RescanResult, ResumeCommand } from "../src/types";
import { designData, designSearch } from "./design";

export type FixtureSourceOptions = {
  /** How long a simulated rescan takes, in ms (the prototype uses 900). */
  rescanMs?: number;
};

export class FixtureSource implements DataSource {
  private readonly rescanMs: number;
  private sessions: number;
  private rescans = 0;
  private autopilot: boolean;
  private readonly on: { skills: Map<string, boolean>; workflows: Map<string, boolean> };

  constructor(opts: FixtureSourceOptions = {}) {
    this.rescanMs = opts.rescanMs ?? 900;
    const d = designData();
    this.sessions = d.sessions;
    this.autopilot = d.router?.autopilot ?? false;
    this.on = {
      skills: new Map(d.skills.items.map((x) => [x.name, x.on])),
      workflows: new Map((d.workflows?.items ?? []).map((x) => [x.name, x.on])),
    };
  }

  /** A fresh copy of the design data with the simulated changes applied. */
  async load(): Promise<TuiData> {
    const d = designData();
    d.sessions = this.sessions;
    for (const x of d.skills.items) x.on = this.on.skills.get(x.name) ?? x.on;
    for (const x of d.workflows?.items ?? []) x.on = this.on.workflows.get(x.name) ?? x.on;
    if (d.router) {
      d.router.autopilot = this.autopilot;
      d.router.sessions = this.sessions;
    }
    return d;
  }

  async toggleItem(kind: "skills" | "workflows", name: string, on: boolean): Promise<ActionResult> {
    const m = this.on[kind];
    if (!m.has(name)) return { ok: false, message: `no ${kind === "skills" ? "skill" : "workflow"} named ${name}`, tone: "bad" };
    m.set(name, on);
    return { ok: true, message: `${on ? "installed" : "removed"} ${kind === "skills" ? name : "wf-" + name}`, tone: on ? "ok" : "dim" };
  }

  async setAutopilot(on: boolean): Promise<ActionResult> {
    this.autopilot = on;
    return { ok: true, message: `autopilot ${on ? "on" : "off"}`, tone: on ? "ok" : "dim" };
  }

  /** The prototype's rescan: 7 new sessions the first time, none after. */
  rescan(): Promise<RescanResult> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const added = this.rescans ? 0 : 7;
        this.rescans++;
        this.sessions += added;
        resolve({ ok: true, message: `rescanned: ${fmt(this.sessions)} sessions, ${added} new`, tone: "ok", sessions: this.sessions, added });
      }, this.rescanMs);
    });
  }

  /** The prototype only shows the command it would run; the fixture never starts a CLI. */
  resume(sessionId: string, turn: number): ResumeCommand | ActionResult {
    const tool = designSearch.session(sessionId).turns[0]?.tool;
    if (!tool) return { ok: false, message: `no session ${sessionId}`, tone: "bad" };
    return { ok: true, message: `${tool === "cursor" ? "cursor-agent" : tool} --resume ${sessionId} at turn ${turn}`, tone: "ok" };
  }
}
