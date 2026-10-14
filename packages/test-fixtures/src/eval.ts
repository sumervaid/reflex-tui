import { ALL_SESSIONS, LONG_PREAMBLE, SPEED_UP } from "./scenarios";
import type { FixtureSession } from "./types";

/**
 * Labeled evaluation set for request matching (synthetic, not real user data). Every session is
 * tagged with the task it performs, so pairwise and clustering quality can be measured against
 * ground truth. Families are worded differently every time, behave alike across families (read,
 * edit, test), and include hard cases: shared words across different tasks ("write tests" vs "fix
 * a flaky test"), pasted stack traces that crowd out the request, and sessions whose first message
 * is only an opener with the real task in the second message. Not in ALL_SESSIONS.
 */

const CRASH_LOG = Array.from(
  { length: 14 },
  (_, i) => `[worker-${i % 3}] 2026-10-0${(i % 9) + 1}T08:1${i % 10}:22.${100 + i}Z ERROR job=reindex-${4100 + i} attempt=${(i % 4) + 1} queue=search-index`,
).join("\n");

const FLAKY_LOG = Array.from(
  { length: 12 },
  (_, i) => `  ${i % 5 === 3 ? "✗" : "✓"} src/orders/sync.test.ts > sync > ${["batches writes", "retries once", "merges partial pages", "keeps order", "drops duplicates"][i % 5]} (${20 + i * 7}ms)`,
).join("\n");

const WRITE_TESTS: FixtureSession[] = [
  {
    key: "ev-tests-1",
    source: "claude-code",
    project: "billing-api",
    daysAgo: 6,
    prompt: "add unit tests for the invoice total calculator, there are none right now",
    steps: [
      { read: "src/invoices/total.ts" },
      { bash: "ls src/invoices" },
      { write: "src/invoices/total.test.ts" },
      { bash: "npm test -- total" },
      { bash: "git diff --stat" },
    ],
    summary: "Added 9 tests for computeTotal covering discounts, tax and empty invoices; all pass.",
  },
  {
    key: "ev-tests-2",
    source: "codex",
    project: "acme-web",
    daysAgo: 5,
    prompt: "can you cover src/utils/date.ts with tests? edge cases around daylight saving especially",
    steps: [
      { read: "src/utils/date.ts" },
      { read: "src/utils/format.test.ts" },
      { write: "src/utils/date.test.ts" },
      { bash: "pnpm vitest run src/utils" },
      { bash: "git diff" },
    ],
    summary: "New date.test.ts with DST transitions for two time zones; one real bug found in addDays, noted but not fixed.",
  },
  {
    key: "ev-tests-3",
    source: "claude-code",
    project: "mobile-app",
    daysAgo: 3,
    prompt: "we need better coverage on the auth middleware, write specs for expired and missing tokens",
    steps: [
      { read: "src/middleware/auth.ts" },
      { grep: "verifyToken" },
      { write: "src/middleware/auth.spec.ts" },
      { bash: "pnpm test -- auth" },
      { bash: "pnpm test -- --coverage" },
    ],
    summary: "Specs for expired, malformed and missing tokens; middleware coverage went from 41% to 93%.",
  },
  {
    key: "ev-tests-4",
    source: "codex",
    project: "infra-tools",
    daysAgo: 2,
    prompt: "write vitest tests for parseConfig in packages/core/src/config.ts",
    steps: [
      { read: "packages/core/src/config.ts" },
      { write: "packages/core/test/config.test.ts" },
      { bash: "pnpm vitest run packages/core" },
      { bash: "git diff --stat" },
    ],
    summary: "Tests for defaults, env overrides and invalid YAML; all green.",
  },
  {
    key: "ev-tests-5",
    source: "claude-code",
    project: "docs-site",
    daysAgo: 1,
    prompt: "hi! I'm going to give you a task in this repo. first just get familiar with how it is laid out.",
    steps: [
      { bash: "ls" },
      { read: "README.md" },
      { read: "package.json" },
      { say: "Got it: an Astro site with a search component and a few utilities." },
      { user: "ok, now add unit tests for the slugify helper, it has none" },
      { read: "src/lib/slugify.ts" },
      { write: "src/lib/slugify.test.ts" },
      { bash: "pnpm test -- slugify" },
    ],
    summary: "Added tests for unicode, repeated dashes and empty input; slugify passes all of them.",
  },
];

const FLAKY_TEST: FixtureSession[] = [
  {
    key: "ev-flaky-1",
    source: "claude-code",
    project: "acme-web",
    daysAgo: 6,
    prompt: "the checkout e2e test fails randomly on CI, maybe 1 in 5 runs. make it stable",
    steps: [
      { read: "e2e/checkout.spec.ts" },
      { bash: "pnpm playwright test e2e/checkout.spec.ts --repeat-each 10", fail: true },
      { edit: "e2e/checkout.spec.ts" },
      { bash: "pnpm playwright test e2e/checkout.spec.ts --repeat-each 20" },
      { bash: "git diff" },
    ],
    summary: "The test clicked Pay before the totals request finished; it now waits for the response. 20/20 runs pass.",
  },
  {
    key: "ev-flaky-2",
    source: "codex",
    project: "mobile-app",
    daysAgo: 4,
    prompt: "UserList.spec passes locally but intermittently times out in the pipeline",
    steps: [
      { read: "src/screens/UserList.spec.tsx" },
      { bash: "pnpm jest UserList --runInBand", fail: true },
      { edit: "src/screens/UserList.spec.tsx" },
      { bash: "for i in 1 2 3 4 5; do pnpm jest UserList || break; done" },
      { bash: "git diff" },
    ],
    summary: "A real timer leaked between tests; switched to fake timers and cleared them in afterEach.",
  },
  {
    key: "ev-flaky-3",
    source: "claude-code",
    project: "billing-api",
    daysAgo: 3,
    prompt:
      "this test is flaky:\nFAIL src/cart.test.ts > applies discount\nAssertionError: expected 90 to be 81\n    at src/cart.test.ts:44:22\nit only happens sometimes",
    steps: [
      { read: "src/cart.test.ts" },
      { bash: "npx vitest run src/cart.test.ts --sequence.shuffle", fail: true },
      { edit: "src/cart.test.ts" },
      { bash: "npx vitest run src/cart.test.ts --sequence.shuffle --repeat 10" },
      { bash: "git diff" },
    ],
    summary: "Tests shared one cart object; a discount from another test leaked in when the order changed. Each test now builds its own cart.",
  },
  {
    key: "ev-flaky-4",
    source: "codex",
    project: "infra-tools",
    daysAgo: 1,
    prompt: "something is nondeterministic in the order tests, they pass when run alone but not with the whole suite",
    steps: [
      { bash: "pnpm test -- orders", fail: false },
      { bash: "pnpm test", fail: true },
      { read: "test/orders.test.ts" },
      { edit: "test/orders.test.ts" },
      { bash: "pnpm test" },
      { bash: "git diff --stat" },
    ],
    summary: "A global mock of Date was never restored; restored it in afterAll. Full suite passes three times in a row.",
  },
  {
    key: "ev-flaky-5",
    source: "codex",
    project: "billing-api",
    daysAgo: 0,
    hoursAgo: 6,
    prompt: `CI output:\n${FLAKY_LOG}\nthe sync test goes red maybe every third run and green again on retry, make it deterministic`,
    steps: [
      { read: "src/orders/sync.test.ts" },
      { bash: "npx vitest run src/orders/sync.test.ts --repeat 15", fail: true },
      { edit: "src/orders/sync.test.ts" },
      { bash: "npx vitest run src/orders/sync.test.ts --repeat 30" },
      { bash: "git diff" },
    ],
    summary: "The test relied on two promises resolving in order; it now awaits both explicitly. 30/30 runs pass.",
  },
];

const CRASH_FIX: FixtureSession[] = [
  {
    key: "ev-crash-1",
    source: "claude-code",
    project: "billing-api",
    daysAgo: 6,
    hoursAgo: 3,
    prompt:
      "getting this in prod:\nTypeError: Cannot read properties of undefined (reading 'id')\n    at serializeUser (src/api/users.ts:42:18)\n    at Array.map (<anonymous>)\n    at listUsers (src/api/users.ts:88:22)\n    at processTicksAndRejections (node:internal/process/task_queues:95:5)\nfix it",
    steps: [
      { read: "src/api/users.ts" },
      { grep: "serializeUser" },
      { edit: "src/api/users.ts" },
      { bash: "npm test -- users" },
      { bash: "git diff" },
    ],
    summary: "Deleted accounts have no profile; serializeUser now skips them instead of crashing. Added a regression test.",
  },
  {
    key: "ev-crash-2",
    source: "codex",
    project: "infra-tools",
    daysAgo: 5,
    prompt:
      "app crashes on startup:\nError: ENOENT: no such file or directory, open '/app/config/default.json'\n    at Object.openSync (node:fs:573:18)\n    at Object.readFileSync (node:fs:452:35)\n    at loadConfig (src/config.ts:12:9)\n    at main (src/index.ts:5:3)\nplease fix",
    steps: [
      { read: "src/config.ts" },
      { bash: "ls config" },
      { edit: "src/config.ts" },
      { bash: "pnpm build" },
      { bash: "pnpm test" },
    ],
    summary: "The config path was resolved from the working directory; it is now resolved from the package root, so the container starts.",
  },
  {
    key: "ev-crash-3",
    source: "claude-code",
    project: "acme-web",
    daysAgo: 3,
    prompt:
      "unhandled promise rejection when the payment webhook arrives twice:\nPrismaClientKnownRequestError: Unique constraint failed on the fields: (`stripeEventId`)\n    at handleWebhook (src/payments/webhook.ts:31:5)\n    at async POST (src/app/api/stripe/route.ts:14:3)",
    steps: [
      { read: "src/payments/webhook.ts" },
      { grep: "stripeEventId" },
      { edit: "src/payments/webhook.ts" },
      { bash: "pnpm test -- webhook" },
      { bash: "git diff" },
    ],
    summary: "Duplicate deliveries hit the unique index; the handler now treats an existing event id as already processed.",
  },
  {
    key: "ev-crash-4",
    source: "codex",
    project: "mobile-app",
    daysAgo: 2,
    prompt:
      "the worker keeps dying with RangeError: Maximum call stack size exceeded at flattenTree (src/tree.ts:17:12) at flattenTree (src/tree.ts:19:14) at flattenTree (src/tree.ts:19:14), can you find out why",
    steps: [
      { read: "src/tree.ts" },
      { grep: "flattenTree" },
      { edit: "src/tree.ts" },
      { bash: "pnpm test -- tree" },
      { bash: "git diff --stat" },
    ],
    summary: "Some trees contain cycles; flattenTree now tracks visited nodes and is iterative.",
  },
  {
    key: "ev-crash-5",
    source: "claude-code",
    project: "docs-site",
    daysAgo: 1,
    hoursAgo: 9,
    prompt: `here is the log from last night:\n${CRASH_LOG}\nFATAL: TypeError: Cannot read properties of null (reading 'slug')\n    at buildIndex (src/search/index.ts:58:31)\nthe indexer crashes on every run since yesterday, please fix it`,
    steps: [
      { read: "src/search/index.ts" },
      { grep: "slug" },
      { edit: "src/search/index.ts" },
      { bash: "pnpm test -- search" },
      { bash: "git diff" },
    ],
    summary: "Draft pages have no slug; buildIndex now skips them. Added a test with a draft page.",
  },
];

const UPDATE_DOCS: FixtureSession[] = [
  {
    key: "ev-docs-1",
    source: "claude-code",
    project: "infra-tools",
    daysAgo: 6,
    prompt: "document the new --dry-run flag in the README",
    steps: [{ read: "README.md" }, { grep: "dry-run" }, { read: "src/cli.ts" }, { edit: "README.md" }, { bash: "git diff README.md" }],
    summary: "Added --dry-run to the options table and a short example.",
  },
  {
    key: "ev-docs-2",
    source: "codex",
    project: "acme-web",
    daysAgo: 4,
    prompt: "the CONTRIBUTING guide still says to use yarn, update it for pnpm",
    steps: [{ read: "CONTRIBUTING.md" }, { grep: "yarn" }, { edit: "CONTRIBUTING.md" }, { bash: "git diff" }],
    summary: "Replaced yarn commands with pnpm equivalents and mentioned corepack.",
  },
  {
    key: "ev-docs-3",
    source: "claude-code",
    project: "billing-api",
    daysAgo: 3,
    prompt: "add a section to docs/api.md describing the new pagination params",
    steps: [{ read: "docs/api.md" }, { read: "src/invoices/list.ts" }, { grep: "cursor" }, { edit: "docs/api.md" }, { bash: "git diff docs" }],
    summary: "Documented cursor and limit, with an example response.",
  },
  {
    key: "ev-docs-4",
    source: "codex",
    project: "mobile-app",
    daysAgo: 2,
    prompt: "write up the env vars the service needs in the docs, a few were added recently",
    steps: [{ grep: "process.env" }, { read: "docs/setup.md" }, { edit: "docs/setup.md" }, { bash: "git diff" }],
    summary: "Listed all 11 variables with defaults; 3 were undocumented.",
  },
  {
    key: "ev-docs-5",
    source: "claude-code",
    project: "acme-web",
    daysAgo: 1,
    prompt: "before anything else, skim the repo so you know where things live",
    steps: [
      { bash: "ls" },
      { read: "README.md" },
      { read: "package.json" },
      { say: "It is a Next.js app with a checkout flow and a small docs folder." },
      { user: "great. the docs don't mention the new feature flags at all, please add a page for them" },
      { grep: "featureFlag" },
      { write: "docs/feature-flags.md" },
      { bash: "git diff --stat" },
    ],
    summary: "New docs/feature-flags.md lists every flag, its default and where it is read.",
  },
];

const ADD_MIGRATION: FixtureSession[] = [
  {
    key: "ev-mig-1",
    source: "claude-code",
    project: "billing-api",
    daysAgo: 6,
    hoursAgo: 6,
    prompt: "add a nullable archived_at column to projects",
    steps: [
      { bash: "ls prisma/migrations" },
      { edit: "prisma/schema.prisma" },
      { bash: "npx prisma migrate dev --name add-archived-at" },
      { bash: "npm test" },
      { bash: "git diff --stat" },
    ],
    summary: "Migration 20261008_add_archived_at adds the column; nothing reads it yet.",
  },
  {
    key: "ev-mig-2",
    source: "codex",
    project: "acme-web",
    daysAgo: 5,
    hoursAgo: 4,
    prompt: "we need an index on orders.created_at, can you write the migration",
    steps: [
      { read: "db/schema.sql" },
      { write: "db/migrations/0042_orders_created_at_idx.sql" },
      { bash: "pnpm db:migrate" },
      { bash: "pnpm test" },
      { bash: "git diff" },
    ],
    summary: "Added a concurrent index migration; it applies cleanly on a fresh database.",
  },
  {
    key: "ev-mig-3",
    source: "claude-code",
    project: "mobile-app",
    daysAgo: 3,
    hoursAgo: 5,
    prompt: "create a migration that renames users.name to users.full_name",
    steps: [
      { bash: "ls supabase/migrations" },
      { write: "supabase/migrations/20261010_rename_full_name.sql" },
      { bash: "supabase db reset" },
      { bash: "pnpm test" },
      { bash: "git diff --stat" },
    ],
    summary: "Migration renames the column and keeps a view with the old name for one release.",
  },
  {
    key: "ev-mig-4",
    source: "codex",
    project: "infra-tools",
    daysAgo: 2,
    hoursAgo: 4,
    prompt: "comments need a soft delete flag, add it to the table with a proper migration",
    steps: [
      { read: "migrations/README.md" },
      { write: "migrations/007_comments_deleted.sql" },
      { bash: "make migrate" },
      { bash: "make test" },
      { bash: "git diff" },
    ],
    summary: "Added comments.deleted boolean default false, applied locally, tests pass.",
  },
];

const RENAME: FixtureSession[] = [
  {
    key: "ev-rename-1",
    source: "codex",
    project: "billing-api",
    daysAgo: 4,
    hoursAgo: 7,
    prompt: "fetchOrders should be called loadOrders from now on, update all call sites",
    steps: [{ grep: "fetchOrders" }, { edit: "src/orders/api.ts" }, { edit: "src/orders/page.ts" }, { bash: "npm run typecheck" }, { bash: "npm test" }],
    summary: "Renamed in 6 files; typecheck and tests pass.",
  },
  {
    key: "ev-rename-2",
    source: "claude-code",
    project: "mobile-app",
    daysAgo: 2,
    hoursAgo: 8,
    prompt: "change the Button component's `kind` prop to `variant` throughout the app",
    steps: [
      { grep: "kind=" },
      { edit: "src/components/Button.tsx" },
      { edit: "src/screens/Settings.tsx" },
      { bash: "pnpm typecheck" },
      { bash: "pnpm test" },
      { bash: "git diff --stat" },
    ],
    summary: "Prop renamed in the component and 14 call sites.",
  },
];

/** Every labeled session: the shared fixtures plus the families above. */
export const EVAL_SESSIONS: FixtureSession[] = [
  ...ALL_SESSIONS,
  ...SPEED_UP,
  ...LONG_PREAMBLE,
  ...WRITE_TESTS,
  ...FLAKY_TEST,
  ...CRASH_FIX,
  ...UPDATE_DOCS,
  ...ADD_MIGRATION,
  ...RENAME,
];

/** Tasks whose sessions share a name prefix; everything else is its own task. */
const TASK_OF_PREFIX: Array<[RegExp, string]> = [
  [/^(ci|ko-ci)-/, "fix-ci"],
  [/^rv-/, "review-pr"],
  [/^dep-/, "debug-dependency"],
  [/^explain-ci-/, "explain-ci"],
  [/^(perf|pre-perf|ko-perf)-/, "speed-up"],
  [/^(pre-rename|ev-rename|ko-rename)-|^misc-rename$/, "rename"],
  [/^(ev|ko)-tests-/, "write-tests"],
  [/^(ev|ko)-flaky-/, "flaky-test"],
  [/^(ev|ko)-crash-/, "crash-fix"],
  [/^(ev|ko)-docs-|^misc-readme$/, "update-docs"],
  [/^(ev|ko)-mig-|^misc-migration$/, "add-migration"],
];

/** The task a labeled session performs. */
export function evalTask(key: string): string {
  return TASK_OF_PREFIX.find(([re]) => re.test(key))?.[1] ?? key;
}
