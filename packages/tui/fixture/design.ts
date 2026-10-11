// Design fixture: the mock data of the Claude Design prototype (docs/design/tui-v5/reference), as
// TuiData. Dev and test only. It is never imported by src/ and never shipped in the CLI bundle.
// Derived values use the prototype's own formulas so the views reproduce the mockups.
import type { Day, Item, ItemList, ModelEvidence, RouterTask, SessionContext, ToolLimits, Turn, TuiData } from "../src/model";
import type { ToolFilter, ToolId, UiState, ViewId } from "../src/types";

const hash = (s: string): number => [...s].reduce((a, c) => a + c.charCodeAt(0), 0);

const COST = [22.4, 31.2, 28.0, 35.1, 40.0, 12.3, 9.1, 33.4, 38.2, 41.6, 36.0, 44.2, 15.3, 11.0, 29.4, 37.1, 42.3, 39.0, 58.0, 18.2, 13.1, 34.0, 36.2, 31.0, 39.5, 35.1, 30.2, 41.27];
const TOK = [9.8, 13.6, 12.1, 15.0, 17.2, 5.1, 3.8, 14.4, 16.6, 17.9, 15.2, 19.1, 6.4, 4.6, 12.3, 16.0, 18.4, 17.1, 24.8, 7.6, 5.5, 14.6, 15.9, 13.2, 17.4, 15.1, 12.7, 18.4];

/** 13 Sep .. 10 Oct 2026, the prototype's `new Date(2026, 8, 13 + i)` labels without a timezone. */
const dayLabel = (i: number): string => {
  const d = 13 + i;
  return d <= 30 ? `${String(d).padStart(2, "0")} Sep` : `${String(d - 30).padStart(2, "0")} Oct`;
};

export const DAYS: Day[] = COST.map((usd, i) => {
  const label = dayLabel(i);
  const h1 = hash(label);
  const cl = 0.62 + (h1 % 14) / 100;
  const cx = 0.22 + (h1 % 9) / 100;
  return { label, usd, tokens: TOK[i]! * 1e6, byTool: { claude: usd * cl, codex: usd * cx, cursor: usd * (1 - cl - cx) } };
});

const LIMITS: ToolLimits[] = [
  {
    tool: "claude",
    plan: "Max 5x",
    bars: [
      { label: "5-hour", short: "5-hour", pct: 64, resets: "in 3h26m" },
      { label: "weekly", short: "weekly", pct: 38, resets: "Thu 9:00" },
      { label: "wk opus", short: "opus", pct: 83, resets: "Thu 9:00" },
    ],
    pace: { text: "hits opus limit Wed 16:00", tone: "warn" },
  },
  {
    tool: "codex",
    plan: "Pro",
    bars: [
      { label: "5-hour", short: "5-hour", pct: 22, resets: "in 1h05m" },
      { label: "weekly", short: "weekly", pct: 47, resets: "Mon 7:30" },
    ],
    pace: { text: "on pace to end the week near 71%", tone: "dim" },
  },
  {
    tool: "cursor",
    plan: "Pro",
    bars: [
      { label: "monthly", short: "monthly", pct: 71, resets: "1 Nov" },
      { label: "fast req", short: "fast req", pct: 44, resets: "1 Nov" },
    ],
    pace: { text: "on pace for about 96% by 1 Nov", tone: "warn" },
  },
];

const Y_MODEL: Array<[string, number]> = [
  ["opus-4-1", 19.4],
  ["sonnet-4-5", 12.05],
  ["gpt-5-codex", 6.92],
  ["haiku-4-5", 1.48],
  ["gpt-5", 1.42],
];
const Y_PROJ: Array<[string, number]> = [
  ["billing-svc", 14.9],
  ["api-gateway", 11.32],
  ["web-dash", 7.15],
  ["infra-tf", 4.6],
  ["ml-eval", 2.1],
  ["agentlens", 1.2],
];
const MODELS: Array<[string, number]> = [
  ["opus-4-1", 512.3],
  ["sonnet-4-5", 268.9],
  ["gpt-5-codex", 132.7],
  ["gpt-5", 30.4],
  ["haiku-4-5", 24.1],
];
const PROJECTS: Array<[string, number]> = [
  ["api-gateway", 296.1],
  ["billing-svc", 214.6],
  ["web-dash", 171.8],
  ["ml-eval", 112.4],
  ["infra-tf", 98.2],
  ["agentlens", 75.3],
];
const PROMPTS: Array<[number, string, string]> = [
  [14.82, "billing-svc", "the reconciliation job double-counts refunds when the webhook retries, find where and fix it without changing the ledger schema"],
  [11.06, "api-gateway", "migrate every handler under internal/routes from the old middleware chain to the new context-based auth, keep behaviour identical"],
  [9.71, "ml-eval", "rerun the eval harness against all 14 checkpoints and tell me which regressions are real and which are noise"],
  [8.4, "web-dash", "why is the dashboard bundle 4.1MB now, it was 1.8MB last month, bisect the dependency changes"],
  [7.95, "infra-tf", "plan shows 212 changes after the provider bump, figure out which ones are cosmetic and which would actually replace resources"],
  [6.88, "api-gateway", "add rate limiting per API key to the public routes, tests first"],
  [6.12, "billing-svc", "explain why invoice totals differ between the PDF and the CSV export for multi-currency accounts"],
];
const SESS: Array<[number, string, ToolId, string, string, number, number, number, string]> = [
  [31.4, "08 Oct", "claude", "billing-svc", "debug", 142, 318, 9.8e6, "the reconciliation job double-counts refunds when the webhook retries"],
  [24.15, "03 Oct", "claude", "api-gateway", "refactor", 96, 260, 7.1e6, "migrate every handler under internal/routes to context-based auth"],
  [19.88, "01 Oct", "codex", "infra-tf", "infra", 88, 191, 6.4e6, "plan shows 212 changes after the provider bump"],
  [17.02, "29 Sep", "claude", "ml-eval", "explain", 61, 77, 5.2e6, "rerun the eval harness against all 14 checkpoints"],
  [15.67, "06 Oct", "codex", "web-dash", "debug", 70, 154, 4.9e6, "why is the dashboard bundle 4.1MB now"],
  [14.2, "05 Oct", "claude", "web-dash", "refactor", 77, 162, 4.6e6, "convert the remaining class components in src/legacy to hooks"],
  [13.75, "30 Sep", "codex", "api-gateway", "test-write", 58, 140, 4.3e6, "write table-driven tests for the token bucket limiter"],
];

type Raw = { name: string; on: number; sup: number; upd: string; state: Item["state"]; desc: string; steps: string[] };
const raw = (a: Array<[string, number, number, string, Item["state"], string, string[]]>): Raw[] =>
  a.map(([name, on, sup, upd, state, desc, steps]) => ({ name, on, sup, upd, state, desc, steps }));

const SKILLS = raw([
  ["pytest-fixture-triage", 1, 14, "10 Oct", "new", "Untangle failing pytest fixtures: scope, ordering and conftest shadowing.", ["Run the single test, then the module, then the package to find the smallest failing scope", "List fixtures with pytest --fixtures-per-test and note session or module scope", "Check every conftest.py on the path for a fixture with the same name", "Make the leaking fixture function-scoped or yield a fresh copy", "Re-run the original failing command, not just the single test", "Report the root cause in one sentence"]],
  ["alembic-migration-review", 1, 9, "10 Oct", "new", "Review an Alembic migration before it reaches a shared database.", ["Read the migration and the model diff side by side", "Flag non-nullable columns added without a server default", "Check downgrade() actually reverses upgrade()", "Run upgrade head then downgrade -1 against a scratch database", "Estimate lock time for tables over 1M rows"]],
  ["terraform-plan-diff", 0, 11, "10 Oct", "new", "Separate real infrastructure changes from cosmetic plan noise.", ["Run terraform plan -out and terraform show -json", "Group changes by resource type and action", "Separate cosmetic diffs (tags, ordering, defaults) from real ones", "List anything that destroys or replaces"]],
  ["flaky-test-bisect", 1, 22, "10 Oct", "updated", "Isolate a flaky test by bisecting order, seed and parallelism before touching code.", ["Reproduce with the CI seed and worker count", "Run the test alone 20 times to measure the base flake rate", "Bisect test order with pytest-randomly and a fixed seed", "Toggle parallelism: -n 0 against -n auto", "Look for shared state: time, network, temp dirs, module globals", "Fix the dependency, not the assertion", "Re-run 50 times and report the new flake rate"]],
  ["openapi-client-regen", 1, 17, "08 Oct", "", "Regenerate the typed API client and fix the fallout.", ["Regenerate from the spec at the pinned generator version", "Diff the generated client and list breaking signature changes", "Update call sites the type checker flags", "Run the contract tests", "Commit generated code separately from hand edits"]],
  ["k8s-crashloop-debug", 1, 31, "10 Oct", "updated", "Find why a pod is in CrashLoopBackOff and propose the smallest fix.", ["kubectl get pod -o wide, note restarts and node", "kubectl describe pod for events, OOMKilled, probe failures", "kubectl logs --previous for the crashed container", "Compare resources against the last good ReplicaSet", "Check config and secret mounts exist and are current", "Reproduce the entrypoint locally with the same env", "Propose the smallest manifest change", "Watch one full rollout before calling it fixed"]],
  ["sql-explain-tuning", 0, 8, "10 Oct", "new", "Speed up a slow Postgres query with evidence from EXPLAIN.", ["Capture the exact query with bound parameters", "Run EXPLAIN (ANALYZE, BUFFERS)", "Find the node with the largest actual vs estimated row gap", "Try one index or rewrite at a time", "Re-run EXPLAIN and compare time and buffers", "Write the migration for the winning index"]],
  ["pr-description-writer", 1, 46, "05 Oct", "", "Write a PR description reviewers can act on.", ["Read the full diff and the linked issue", "Write what changed, why, and how it was tested, in that order", "List follow-ups and what reviewers should look at first"]],
  ["react-hook-refactor", 0, 12, "10 Oct", "new", "Convert a class component to hooks without changing behaviour.", ["Identify state, effects and refs in the class component", "Map lifecycle methods to useEffect with explicit dependencies", "Add useMemo only where profiling shows a cost", "Keep the public props interface unchanged", "Run the component tests and the story snapshots"]],
  ["dependency-bump-triage", 1, 19, "07 Oct", "", "Decide whether a dependency bump is safe and what it breaks.", ["Read the changelog between current and target versions", "Search the codebase for every removed or renamed API", "Bump, run the full test suite, then the type checker", "Split into one PR per major bump"]],
  ["log-grep-incident", 1, 27, "10 Oct", "updated", "Build an incident timeline from logs across replicas.", ["Pin the incident window in UTC", "Pull logs for that window only, across all replicas", "Group errors by message template, not exact text", "Find the first occurrence and what deployed just before it", "Correlate with metrics for the same window", "Write a timeline with timestamps and sources"]],
  ["dockerfile-slimming", 0, 6, "10 Oct", "new", "Shrink a container image without breaking startup.", ["Measure image and layer sizes with docker history", "Move to a multi-stage build with a slim runtime base", "Order layers so dependencies cache before source", "Verify the app starts and health checks pass"]],
  ["grpc-proto-compat", 1, 10, "03 Oct", "", "Change a .proto without breaking existing clients.", ["Run buf breaking against the main branch", "Never reuse or renumber field tags", "Mark removed fields reserved", "Regenerate stubs for every consuming service", "Deploy servers before clients"]],
  ["celery-retry-audit", 0, 5, "10 Oct", "retired", "Audit Celery tasks for unsafe retries.", ["Find tasks with autoretry_for but no max_retries", "Check retried tasks are idempotent", "Add exponential backoff with jitter"]],
  ["jest-snapshot-cleanup", 0, 4, "10 Oct", "retired", "Remove obsolete Jest snapshots.", ["Run jest --ci to list obsolete snapshots", "Remove them in a separate commit"]],
  ["benchmark-regression", 0, 9, "10 Oct", "new", "Confirm and locate a performance regression between two commits.", ["Run the benchmark on main and on the branch, same machine, 5 runs each", "Compare medians, not means", "Profile the slower side with py-spy or perf", "Locate the hot function that changed", "Fix or justify the regression", "Attach before/after numbers to the PR"]],
  ["rate-limit-tuning", 0, 8, "10 Oct", "new", "Set API rate limits from observed traffic.", ["Find current limits in config and gateway middleware", "Pull p50/p99 request rates per key for the last 7 days", "Set limits at p99 x 1.5 with a burst allowance", "Return Retry-After on 429", "Add a test for the boundary"]],
  ["schema-drift-check", 0, 8, "10 Oct", "new", "Detect drift between the live schema and the ORM models.", ["Dump the live schema with pg_dump --schema-only", "Generate the schema the models expect", "Diff and classify: missing, extra, type mismatch", "Write a migration for each real mismatch", "Add the check to CI"]],
]);

const WFS = raw([
  ["ship-small-fix", 1, 38, "06 Oct", "", "Take a small bug from report to merged PR.", ["Reproduce: write a failing test first", "Patch: the smallest change that makes it pass", "Verify: full test suite and type checker", "Describe: PR description (skill: pr-description-writer)", "Stop: hand back the PR link"]],
  ["incident-first-hour", 1, 12, "10 Oct", "updated", "First hour of a production incident: timeline, blast radius, mitigation.", ["Window: pin start time and affected services", "Logs: skill log-grep-incident", "Pods: skill k8s-crashloop-debug if any service is restarting", "Blast radius: which customers and endpoints", "Mitigate: roll back or flag off before root-causing", "Write: timeline and next steps for the channel"]],
  ["migration-with-backfill", 0, 9, "10 Oct", "new", "Schema change plus data backfill without downtime.", ["Plan: expand, backfill, contract", "Migration: skill alembic-migration-review", "Backfill: batched job with progress and resume", "Switch reads, then writes", "Contract: drop the old column in a later release"]],
  ["dep-upgrade-sweep", 1, 15, "10 Oct", "updated", "Monthly dependency upgrade across a repository.", ["List outdated packages", "Triage: skill dependency-bump-triage", "Upgrade minors in one PR", "Upgrade each major in its own PR", "Benchmark runtime dependencies: skill benchmark-regression"]],
  ["api-endpoint-scaffold", 1, 21, "01 Oct", "", "New REST endpoint with schema, handler, tests and client.", ["Spec: add the path to openapi.yaml", "Handler and validation", "Tests: happy path, auth, bad input", "Client: skill openapi-client-regen", "Docs: example request and response"]],
  ["perf-regression-hunt", 0, 7, "10 Oct", "new", "Find and fix a reported slowdown.", ["Reproduce with a benchmark: skill benchmark-regression", "Bisect commits between good and bad", "Profile the culprit", "Fix and attach before/after numbers"]],
  ["release-notes-draft", 0, 5, "10 Oct", "retired", "Draft release notes from merged PRs.", ["Collect merged PRs since the last tag", "Group by area", "Write user-facing notes"]],
  ["feature-flag-rollout", 0, 8, "30 Sep", "", "Ship behind a flag and ramp safely.", ["Add the flag, default off", "Ship both code paths behind it", "Ramp 1%, 10%, 50%, 100% with checks between", "Remove the flag and the dead path"]],
  ["test-gap-fill", 1, 18, "10 Oct", "updated", "Raise coverage where bugs actually happened.", ["Map recent bug-fix commits to files", "Read coverage for those files", "Write tests for uncovered branches", "Run skill flaky-test-bisect on anything intermittent"]],
]);

/** The prototype's generated SKILL.md / workflow command, including its hash-based evidence lines. */
function itemMd(x: Raw, isS: boolean): string[] {
  const h = hash(x.name);
  const cc = Math.round(x.sup * (0.5 + (h % 40) / 100));
  const cx = x.sup - cc;
  const L = ["---", `name: ${isS ? x.name : "wf-" + x.name}`, `description: ${x.desc}`];
  if (!isS) L.push("argument-hint: <task>");
  L.push(`support: ${x.sup} sessions (${cc} claude, ${cx} codex)`);
  if (x.state === "retired") L.push("status: retired, no matching sessions in 30 days");
  L.push(`generated: agentlens 0.4.2, ${x.upd} 2026`, "---", "");
  if (isS) L.push(`# ${x.name}`, "", x.desc, "", "## Steps");
  else L.push(`# /wf-${x.name} <task>`, "", `${x.desc} Apply to: $ARGUMENTS`, "Run the phases in order. Stop and report if a phase check fails.", "", "## Phases");
  x.steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push("", "## Evidence");
  const P = ["api-gateway", "billing-svc", "web-dash", "ml-eval", "infra-tf", "agentlens"];
  const D = ["10 Oct", "08 Oct", "06 Oct", "03 Oct", "01 Oct", "29 Sep", "26 Sep", "22 Sep"];
  for (let i = 0; i < Math.min(5, x.sup); i++)
    L.push(`- ${D[(h + i * 3) % D.length]}  ${P[(h + i * 5) % P.length]!.padEnd(12)} ${(i + h) % 3 ? "claude" : "codex "}  ${12 + ((h * (i + 1)) % 60)} turns`);
  if (x.sup > 5) L.push(`- ${x.sup - 5} more sessions`);
  return L;
}

const items = (list: Raw[], isS: boolean): Item[] =>
  list.map((x) => ({
    name: x.name,
    on: !!x.on,
    support: x.sup,
    updated: x.upd,
    state: x.state,
    steps: x.steps.length,
    path: isS ? `~/.claude/skills/${x.name}/SKILL.md` : `~/.claude/commands/wf-${x.name}.md`,
    markdown: itemMd(x, isS),
  }));

const MIN_SUP = 8;
const MARGIN = 0.05;
const PLAIN: Record<string, string> = {
  debug: "Debugging",
  refactor: "Refactoring",
  "test-write": "Writing tests",
  migrate: "Migrations",
  review: "Code review",
  docs: "Writing docs",
  infra: "Infrastructure",
  explain: "Explaining code",
};
const ROUTER_RAW: Array<{ k: string; prev?: string; ev: Array<[string, number, number, number]> }> = [
  { k: "debug", prev: "opus-4-1", ev: [["opus-4-1", 51, 2.31, 0.14], ["gpt-5-codex", 24, 1.39, 0.15], ["sonnet-4-5", 9, 1.12, 0.22]] },
  { k: "refactor", prev: "sonnet-4-5", ev: [["sonnet-4-5", 44, 0.78, 0.09], ["haiku-4-5", 12, 0.37, 0.11], ["opus-4-1", 7, 2.05, 0.08]] },
  { k: "test-write", ev: [["sonnet-4-5", 52, 0.64, 0.07], ["haiku-4-5", 11, 0.29, 0.16], ["gpt-5-codex", 8, 0.71, 0.08]] },
  { k: "migrate", ev: [["opus-4-1", 18, 3.1, 0.11], ["sonnet-4-5", 4, 1.2, 0.25]] },
  { k: "review", ev: [["sonnet-4-5", 60, 0.42, 0.05], ["haiku-4-5", 35, 0.23, 0.08]] },
  { k: "docs", ev: [["sonnet-4-5", 28, 0.38, 0.03], ["haiku-4-5", 12, 0.17, 0.04]] },
  { k: "infra", ev: [["gpt-5-codex", 25, 1.02, 0.12], ["opus-4-1", 12, 2.6, 0.1]] },
  { k: "explain", ev: [["opus-4-1", 30, 1.71, 0.04], ["sonnet-4-5", 28, 0.66, 0.06]] },
];

/** The prototype's policy: cheapest model whose friction is within MARGIN of the best supported one. */
const TASKS: RouterTask[] = ROUTER_RAW.map((r) => {
  const sup = r.ev.filter((e) => e[1] >= MIN_SUP);
  const best = Math.min(...sup.map((e) => e[3]));
  const ok = sup.filter((e) => e[3] <= best + MARGIN + 1e-9);
  const rec = ok.reduce((a, e) => (e[2] < a[2] ? e : a));
  const most = r.ev.reduce((a, e) => (e[1] > a[1] ? e : a));
  const evidence: ModelEvidence[] = r.ev.map(([model, sessions, usd, friction]) => ({ model, sessions, usd, friction }));
  return {
    key: r.k,
    name: PLAIN[r.k]!,
    evidence,
    rec: rec[0],
    most: most[0],
    mostSessions: most[1],
    save: Math.round((most[2] - rec[2]) * 100) / 100,
    sessions: r.ev.reduce((a, e) => a + e[1], 0),
    best,
    ...(r.prev ? { previous: r.prev } : {}),
  };
});

type RawTurn = [string, ToolId, string, string, number, "you" | "ai", string];
const TURNS: RawTurn[] = [
  ["08 Oct", "claude", "billing-svc", "a41f", 12, "you", "the reconciliation job double-counts refunds when the webhook retries, find where and fix it without changing the ledger schema"],
  ["08 Oct", "claude", "billing-svc", "a41f", 13, "ai", "The refund webhook handler in payments/webhooks.py calls apply_refund() before it checks the idempotency key, so a retried webhook inserts a second ledger row."],
  ["08 Oct", "claude", "billing-svc", "a41f", 41, "ai", "Fixed: apply_refund() now runs inside the idempotency guard. Added test_refund_webhook_retry_is_idempotent; all 214 billing tests pass."],
  ["08 Oct", "claude", "billing-svc", "a41f", 42, "you", "good, also backfill the duplicated refund rows from last week"],
  ["02 Oct", "codex", "billing-svc", "c9e2", 7, "ai", "Stripe sends refund.updated and charge.refunded for the same refund; the webhook router treats them as two separate events."],
  ["21 Sep", "claude", "api-gateway", "77b0", 18, "you", "why does the webhook signature check fail only in staging"],
  ["21 Sep", "claude", "api-gateway", "77b0", 19, "ai", "Staging terminates TLS at the load balancer and re-encodes the body, so the webhook signature is computed over different bytes."],
  ["06 Oct", "codex", "web-dash", "e310", 3, "you", "why is the dashboard bundle 4.1MB now, it was 1.8MB last month, bisect the dependency changes"],
  ["06 Oct", "codex", "web-dash", "e310", 22, "ai", "The jump comes from chart-kit 5.0 pulling in every locale. Importing chart-kit/core brings the bundle back to 1.9MB."],
  ["03 Oct", "claude", "api-gateway", "5d18", 2, "you", "migrate every handler under internal/routes from the old middleware chain to the new context-based auth, keep behaviour identical"],
  ["03 Oct", "claude", "api-gateway", "5d18", 57, "ai", "All 38 handlers migrated. The refund and payout routes needed an extra scope check that the old chain applied implicitly."],
  ["01 Oct", "codex", "infra-tf", "0b7c", 9, "ai", "Of the 212 planned changes, 198 are tag reordering from the provider bump. 14 are real, and 2 would replace the RDS parameter group."],
  ["29 Sep", "claude", "ml-eval", "91aa", 30, "ai", "Checkpoints 9 and 12 regress on the refund-intent slice by 4.1 points; the rest are within seed noise."],
  ["05 Oct", "claude", "web-dash", "3c44", 14, "you", "convert the remaining class components in src/legacy to hooks"],
  ["09 Oct", "cursor", "agentlens", "f02d", 6, "you", "add a full-text search over every turn, sqlite fts5 is fine"],
  ["09 Oct", "cursor", "agentlens", "f02d", 19, "ai", 'Indexed 41,208 turns into turns_fts. A query for "refund webhook" returns in 8ms.'],
  ["30 Sep", "codex", "api-gateway", "b812", 11, "you", "write table-driven tests for the token bucket limiter"],
  ["26 Sep", "claude", "billing-svc", "6e90", 4, "you", "explain why invoice totals differ between the PDF and the CSV export for multi-currency accounts"],
  ["26 Sep", "claude", "billing-svc", "6e90", 9, "ai", "The CSV export rounds each line before converting currency; the PDF converts first. Refunds widen the gap because they are negative lines."],
  ["10 Oct", "claude", "billing-svc", "a7d3", 5, "you", "the refund backfill script timed out on prod, make it batch by 500 and resume from the last id"],
];
const SMETA: Record<string, { usd: number; turns: number; files?: string }> = {
  a41f: { usd: 31.4, turns: 142, files: "payments/webhooks.py  ledger/refunds.py" },
  c9e2: { usd: 6.1, turns: 22 },
  "77b0": { usd: 4.8, turns: 31 },
  e310: { usd: 15.67, turns: 70 },
  "5d18": { usd: 24.15, turns: 96 },
  "0b7c": { usd: 19.88, turns: 88 },
  "91aa": { usd: 17.02, turns: 61 },
  "3c44": { usd: 14.2, turns: 77 },
  f02d: { usd: 3.9, turns: 24 },
  b812: { usd: 13.75, turns: 58 },
  "6e90": { usd: 6.12, turns: 18 },
  a7d3: { usd: 2.4, turns: 9, files: "scripts/backfill_refunds.py" },
};

const toTurn = ([date, tool, project, session, turn, role, text]: RawTurn): Turn => ({ date, tool, project, session, turn, role, text });
const MI: Record<string, number> = { Sep: 9, Oct: 10 };
const dk = (d: string): number => MI[d.slice(3)]! * 100 + Number(d.slice(0, 2));

export const designSearch = {
  indexed: 41208,
  /** The prototype's `searchHits`: tool filter, case-insensitive substring, newest date then highest turn. */
  query(q: string, tool: ToolFilter): Turn[] {
    const lq = q.trim().toLowerCase();
    return TURNS.filter((t) => (tool === "all" || t[1] === tool) && (!lq || t[6].toLowerCase().includes(lq)))
      .sort((a, b) => dk(b[0]) - dk(a[0]) || b[4] - a[4])
      .map(toTurn);
  },
  session(id: string): SessionContext {
    const m = SMETA[id];
    return {
      turns: TURNS.filter((x) => x[3] === id)
        .sort((a, b) => a[4] - b[4])
        .map(toTurn),
      ...(m ? { usd: m.usd, turnCount: m.turns } : {}),
      ...(m?.files ? { files: m.files } : {}),
    };
  },
};

const list = (it: Item[], targets: string[]): ItemList => ({ items: it, targets });

/** The full design data set, as the prototype renders it. Each call returns a fresh copy. */
export function designData(): TuiData {
  const tasks = TASKS.map((t) => ({ ...t, evidence: t.evidence.map((e) => ({ ...e })) }));
  return {
    scannedAt: "08:02",
    sessions: 1284,
    dataDir: "~/.local/share/agentlens",
    reads: ["~/.claude/projects", "~/.codex/sessions"],
    activeDirs: ["~/.claude/skills", "~/.claude/commands", "~/.codex/prompts"],
    limits: LIMITS.map((l) => ({ ...l, bars: l.bars.map((b) => ({ ...b })) })),
    plansFile: "~/.config/agentlens/plans.toml",
    money: { today: { usd: 12.4, sessions: 6 }, allTime: { usd: 4735.8, since: "14 Mar" }, month: { usd: 246.4 }, dailyBudget: 40 },
    days: DAYS.map((d) => ({ ...d, byTool: { ...d.byTool } })),
    yesterday: {
      label: "sat 10 oct",
      sessions: 23,
      contextTokens: 18.4e6,
      outputTokens: 312e3,
      byTool: [
        { name: "claude", usd: 30.12 },
        { name: "codex", usd: 8.35 },
        { name: "cursor", usd: 2.8 },
      ],
      byModel: Y_MODEL.map(([name, usd]) => ({ name, usd })),
      byProject: Y_PROJ.map(([name, usd]) => ({ name, usd })),
    },
    window: {
      days: 30,
      range: "11 sep – 10 oct",
      sessions: 612,
      tokens: { input: 28.3e6, cacheWrite: 31.9e6, cacheRead: 352.4e6, output: 7.9e6 },
      usd: { output: 370.2, cacheRead: 308.6, cacheWrite: 171.4, input: 118.2, total: 968.4, uncached: 3214.9 },
      byModel: MODELS.map(([name, usd]) => ({ name, usd })),
      byProject: PROJECTS.map(([name, usd]) => ({ name, usd })),
    },
    tools: [
      { tool: "claude", sessions: 420, usd: 701.2, allTimeUsd: 3412.6 },
      { tool: "codex", sessions: 148, usd: 214.6, allTimeUsd: 1108.3 },
      { tool: "cursor", sessions: 44, usd: 52.6, allTimeUsd: 214.9 },
    ],
    topPrompts: PROMPTS.map(([usd, project, text]) => ({ usd, project, text })),
    topSessions: SESS.map(([usd, date, tool, project, kind, turns, toolCalls, contextTokens, prompt]) => ({
      usd,
      date,
      tool,
      project,
      kind,
      turns,
      toolCalls,
      contextTokens,
      prompt,
    })),
    skills: list(items(SKILLS, true), ["~/.claude/skills/<name>/SKILL.md", "~/.codex/prompts/<name>.md"]),
    workflows: list(items(WFS, false), ["~/.claude/commands/wf-<name>.md", "~/.codex/prompts/wf-<name>.md"]),
    router: {
      autopilot: true,
      sessions: 1284,
      rebuiltAt: "08:02",
      policyFile: "~/.config/agentlens/router-policy.json",
      minSupport: MIN_SUP,
      margin: MARGIN,
      monthlySaving: tasks.reduce((a, t) => a + t.save * t.mostSessions, 0),
      movedSessions: tasks.filter((t) => t.save > 0).reduce((a, t) => a + t.mostSessions, 0),
      tasks,
    },
    attention: [
      { tone: "warn", text: "weekly opus limit 83%, on pace to run out Wed", view: "dashboard" },
      { tone: "ok", text: "11 new skills and workflows to review", view: "skills" },
      { tone: "warn", text: "debug and refactor now route to cheaper models", view: "router" },
      { tone: "warn", text: "5 days over the $40 daily budget this month", view: "tokens" },
      { tone: "bad", text: "3 retired recipes are still installed", view: "skills" },
    ],
    search: designSearch,
  };
}

/** The state the mockups were dumped with: only the dashboard has been seen, whatever view is shown. */
export function designUi(view: ViewId): UiState {
  return {
    view,
    seen: ["dashboard"],
    sidebar: "full",
    sel: { skills: 3, workflows: 1, router: 0, search: 0 },
    previewScroll: 0,
    query: "refund",
    searchQuery: "refund",
    typing: false,
    tool: "all",
    scanning: false,
    toast: null,
    clock: "08:14:07",
  };
}
