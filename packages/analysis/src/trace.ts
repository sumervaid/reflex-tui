import type { ActionCategory, CommandFingerprint, NormalizedSession, WorkflowTrace } from "@reflex/core";
import { shortHash } from "@reflex/core";
import { excerpt } from "@reflex/safety";
import { type FileCategory, MODIFY_ACTIONS, VERIFY_ACTIONS, classifyCommand, fileAction, fileCategory } from "./classify";
import { extractCorrections } from "./corrections";
import { contextHash, sessionContext } from "./context";
import { intentTerms } from "./intents";

const TOOL_ACTIONS: Record<string, ActionCategory> = {
  Grep: "search-code",
  Glob: "search-code",
  WebFetch: "research",
  WebSearch: "research",
};

const MAX_SEQUENCE = 80;

const FILE_LABEL: Record<FileCategory, string> = {
  "ci-config": "CI workflow",
  "dependency-manifest": "dependency manifest",
  test: "test file",
  config: "config file",
  docs: "docs",
  migration: "migration",
  logs: "log file",
  source: "source file",
};

type Step = { action: ActionCategory; isError?: boolean; command?: CommandFingerprint };

/** `skills/<name>/SKILL.md` anywhere except Reflex's own generated copies. */
const SKILL_FILE = /(?:^|[/\\])skills[/\\]([A-Za-z0-9._-]{1,80})[/\\]SKILL\.md\b/g;

function skillsIn(text: string): string[] {
  if (/[/\\]\.reflex[/\\]skills[/\\]/.test(text)) return [];
  return [...text.matchAll(SKILL_FILE)].map((m) => m[1]!);
}

/** True if the trace loaded this skill. Claude Code may prefix plugin skills (`plugin:name`). */
export function usedSkill(trace: WorkflowTrace, name: string): boolean {
  return (trace.skillsUsed ?? []).some((s) => s === name || s.endsWith(`:${name}`));
}

export function buildTrace(session: NormalizedSession): WorkflowTrace {
  const steps: Step[] = [];
  const commands: CommandFingerprint[] = [];
  const tools = new Set<string>();
  const fileCategories = new Set<string>();
  const eventHashes: string[] = [];
  const displaySteps: string[] = [];
  const skills = new Set<string>();
  let toolCalls = 0;
  const show = (s: string) => {
    if (displaySteps[displaySteps.length - 1] !== s && displaySteps.length < MAX_SEQUENCE) displaySteps.push(s);
  };

  for (const ev of session.events) {
    if (ev.kind === "shell" || ev.kind === "file" || ev.kind === "tool") toolCalls++;
    switch (ev.kind) {
      case "shell": {
        tools.add("shell");
        for (const s of skillsIn(ev.command)) skills.add(s);
        for (const fp of classifyCommand(ev.command)) {
          commands.push(fp);
          steps.push({ action: fp.action, isError: ev.isError, command: fp });
          show(fp.normalized);
        }
        eventHashes.push(shortHash(`shell|${ev.at ?? ""}|${ev.command}`));
        break;
      }
      case "file": {
        tools.add(`file-${ev.op}`);
        if (ev.op === "read") for (const s of skillsIn(ev.path)) skills.add(s);
        const category = fileCategory(ev.path);
        fileCategories.add(category);
        steps.push({ action: fileAction(ev.op, category), isError: ev.isError });
        show(`${ev.op === "read" ? "read" : "edit"} ${FILE_LABEL[category]}`);
        eventHashes.push(shortHash(`file|${ev.at ?? ""}|${ev.op}|${ev.path}`));
        break;
      }
      case "tool": {
        tools.add(ev.tool);
        if (ev.skill) skills.add(ev.skill);
        const action = TOOL_ACTIONS[ev.tool];
        if (action) {
          steps.push({ action, isError: ev.isError });
          show(action === "search-code" ? "search code" : "look up docs");
        }
        break;
      }
      case "user":
        eventHashes.push(shortHash(`user|${ev.at ?? ""}|${ev.text}`));
        break;
      default:
        break;
    }
  }

  // Shell reads of files (cat/sed) also tell us which file categories were touched.
  for (const fp of commands) {
    if (fp.action === "inspect-ci") fileCategories.add("ci-config");
    if (fp.action === "inspect-dependencies" && /<file>/.test(fp.normalized)) fileCategories.add("dependency-manifest");
  }

  const lastAssistant = [...session.events].reverse().find((e) => e.kind !== "error");
  const summarized = lastAssistant?.kind === "assistant";

  const actionSequence: ActionCategory[] = [];
  for (const s of steps) {
    if (actionSequence[actionSequence.length - 1] !== s.action) actionSequence.push(s.action);
  }
  if (summarized) actionSequence.push("summarize");

  const intents = session.requests.slice(0, 3).flatMap((r) => intentTerms(r.text));
  const fingerprint = shortHash(
    [session.source, session.startedAt ?? "", session.project?.pathHash ?? "", session.requests.map((r) => r.text).join("\n"), actionSequence.join(">")].join("|"),
    16,
  );

  const trace: WorkflowTrace = {
    sessionId: session.id,
    source: session.source,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    projectName: session.project?.name,
    projectHash: session.project?.pathHash,
    intents,
    tools: [...tools].sort(),
    commands,
    fileCategories: [...fileCategories].sort(),
    actionSequence: actionSequence.slice(0, MAX_SEQUENCE),
    displaySteps,
    outcome: outcomeOf(steps, summarized),
    excerpt: excerpt(session.requests[0]?.text ?? "", 180),
    fingerprint,
    eventHashes,
    sourceFile: session.sourceRef.file,
    usage: session.usage,
    usageByModel: session.usageByModel,
    requests: session.requests.length,
    toolErrors: session.events.filter((e) => "isError" in e && e.isError === true).length,
    toolCalls,
    skillsUsed: [...skills].sort(),
    corrections: extractCorrections(session.requests.map((r) => r.text)),
  };
  // Only a hash is kept: the longer request text used for embedding is never stored.
  trace.contextHash = contextHash(sessionContext(session, trace));
  return trace;
}

function outcomeOf(steps: Step[], summarized: boolean): WorkflowTrace["outcome"] {
  let lastModify = -1;
  steps.forEach((s, i) => {
    if (MODIFY_ACTIONS.has(s.action)) lastModify = i;
  });
  const verified = steps.some((s, i) => i > lastModify && VERIFY_ACTIONS.has(s.action) && !s.isError);
  const failedAt = steps.findIndex((s) => s.isError);
  const recoveredFromFailure = failedAt >= 0 && steps.slice(failedAt + 1).some((s) => VERIFY_ACTIONS.has(s.action) && !s.isError);
  return { verified, recoveredFromFailure, modified: lastModify >= 0, summarized };
}

/** Behavior too generic to be a reusable workflow, e.g. "read a file and answer". */
export function isGenericTrace(trace: WorkflowTrace): boolean {
  const distinct = new Set(trace.actionSequence.filter((a) => a !== "summarize"));
  return distinct.size < 3;
}
