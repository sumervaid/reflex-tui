import type { ActionCategory, CommandFingerprint, NormalizedSession, WorkflowTrace } from "@reflix/core";
import { shortHash } from "@reflix/core";
import { excerpt } from "@reflix/safety";
import { MODIFY_ACTIONS, VERIFY_ACTIONS, classifyCommand, fileAction, fileCategory } from "./classify";
import { intentTerms } from "./intents";

const TOOL_ACTIONS: Record<string, ActionCategory> = {
  Grep: "search-code",
  Glob: "search-code",
  WebFetch: "research",
  WebSearch: "research",
};

const MAX_SEQUENCE = 80;

type Step = { action: ActionCategory; isError?: boolean; command?: CommandFingerprint };

export function buildTrace(session: NormalizedSession): WorkflowTrace {
  const steps: Step[] = [];
  const commands: CommandFingerprint[] = [];
  const tools = new Set<string>();
  const fileCategories = new Set<string>();
  const eventHashes: string[] = [];

  for (const ev of session.events) {
    switch (ev.kind) {
      case "shell": {
        tools.add("shell");
        for (const fp of classifyCommand(ev.command)) {
          commands.push(fp);
          steps.push({ action: fp.action, isError: ev.isError, command: fp });
        }
        eventHashes.push(shortHash(`shell|${ev.at ?? ""}|${ev.command}`));
        break;
      }
      case "file": {
        tools.add(`file-${ev.op}`);
        const category = fileCategory(ev.path);
        fileCategories.add(category);
        steps.push({ action: fileAction(ev.op, category), isError: ev.isError });
        eventHashes.push(shortHash(`file|${ev.at ?? ""}|${ev.op}|${ev.path}`));
        break;
      }
      case "tool": {
        tools.add(ev.tool);
        const action = TOOL_ACTIONS[ev.tool];
        if (action) steps.push({ action, isError: ev.isError });
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

  return {
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
    outcome: outcomeOf(steps, summarized),
    excerpt: excerpt(session.requests[0]?.text ?? "", 180),
    fingerprint,
    eventHashes,
    sourceFile: session.sourceRef.file,
  };
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
