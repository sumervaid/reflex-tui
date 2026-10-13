# Reflex

Reflex finds the workflows you keep re-explaining to Claude Code, Codex and Cursor, and turns the ones
you have really repeated into reusable skills. It runs entirely on your machine.

```
scan history → find repeats across ≥ 3 independent sessions → show evidence
            → you approve → SKILL.md in ~/.reflex/skills → you install → a fresh agent session uses it
```

## Quick start

Requires Node.js 22.13 or newer.

```sh
npm install -g reflex-skills   # installs the `reflex` command (the npm name `reflex` is a different package)
reflex doctor             # what Reflex can see, without reading anything
reflex scan --days 30     # read your Claude Code / Codex / Cursor history (asks first)
reflex suggest            # review suggestions: [a]pprove, [e]vidence, [r]eject
reflex install <name>     # copy a skill into Claude Code, Codex and/or Cursor (asks per target)
```

Suggestions need the same kind of task in at least 3 independent sessions. If a week of history
finds nothing, try a longer window (`--days 30`).

From source (needs pnpm):

```sh
pnpm install && pnpm build && pnpm test
alias reflex="node $PWD/apps/cli/dist/reflex.js"
```

## Commands

| Command | What it does |
| --- | --- |
| `doctor` | Node and SQLite check, detected history locations and file counts, install targets, agent CLIs |
| `scan --days <n>` | Ask per source, then read and store redacted workflow traces. `--source <claude-code\|codex\|cursor>` (repeatable), `--claude-dir`, `--codex-dir`, `--cursor-dir`, `--yes`, `--full` (re-read every file instead of reusing unchanged ones) |
| `sessions` | Sessions from the last scan, redacted |
| `suggest` | Detect repeated workflows and review them interactively (`--no-interactive`, `--all`) |
| `show <n\|name>` | A suggestion in detail: steps, support, uncertainty |
| `evidence <n\|name>` | The sessions behind a suggestion: redacted request, actions, outcome, source |
| `approve <n\|name>` | Generate `~/.reflex/skills/<name>/SKILL.md` (at most 150 lines) |
| `reject <n\|name>` | Stop suggesting it |
| `skills` | Generated skills and where they are installed |
| `show-skill <name>` | Print a generated skill |
| `install <name>` | Install into Claude Code, Codex or Cursor. `--target`, `--as <new-name>`, `--yes`. Never overwrites |
| `explain <name>` | Why the skill exists: sessions, repositories, agents, steps, installs |
| `validate <name>` | Static checks and installed-copy comparison. For `fix-ci`, also a fresh-task sandbox (`--run` starts Claude Code) |
| `impact [name]` | Tokens and tool calls per run before the skill vs. runs that loaded it, plus the skill's own size |
| `tui` | Full-screen terminal UI over the last scan: sessions, tokens, skills to review. `space` installs or removes a skill. Needs an interactive terminal |
| `memory` | What new agent sessions remember: corrections you gave in at least 2 independent sessions. `on` writes a marked block into `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` (refreshed after every scan), `off` removes it, plus `forget`, `remember` and `add` |
| `run <request>` | Start Claude Code or Codex on the model the router picks for this kind of task. `--dry-run` shows the pick and why, `--tool`, `--model`, `--yes`. Asks first unless autopilot is on |
| `route` | The router: picks per kind of task, settings, randomized trials and bench results. `autopilot on\|off`, `explore <percent>\|off [--protect <kind...>]` |
| `bench <task>` | Run one task on several Claude Code models, each in a fresh copy of the current repository, scored by `--check "<command>"`. `--models`, `--setup`, `--runs`, `--timeout`, `--keep`, `--yes` |
| `stats` | Counts from local data |
| `reset` | Delete Reflex's own data (not installed skills or the model) |
| `model [status\|fetch\|remove]` | Optional local embedding model for matching requests by meaning (`fetch` downloads 23 MB) |

Prompts default to No. Without a terminal, nothing is read or written unless you pass `--yes`.

## Terminal UI

```sh
reflex scan --days 7   # the UI shows what the last scan read, so scan first
reflex                 # or `reflex tui`
```

`reflex` on its own (or `reflex tui`) opens a full-screen view of Reflex's local data in seven
views: Dashboard, Morning, Tokens, Skills, Workflows, Router and Search (keys `0`-`6`). It shows
sessions per tool, tokens from the last scan and what they would cost at API list prices (per day,
tool, model and project, the most expensive sessions, what caching saved), generated skills plus
suggestions waiting for review, every repeated workflow with the evidence behind it, router
suggestions (which model was cheapest and about as reliable, per kind of task), and a search over
each session's opening request and steps. Enter reopens a Claude Code or Codex session, or opens a
Cursor chat's workspace in Cursor. Cursor records no tokens, so its sessions have no cost; if you
allow it, Reflex reads which model each Cursor chat used and Tokens counts Cursor sessions per
model. Usage
limits are not recorded, so that block says `not measured yet`. Run `reflex scan` again (or press
`r`) after upgrading: costs need the model of each session, which older scans did not store.

In Skills, `space` on a new suggestion approves it and installs it into every detected agent;
`space` on an installed skill removes the copies Reflex wrote, unless you edited them. `r`
repeats the last scan with the same window and sources. `q` quits. Details: [docs/tui.md](docs/tui.md).

## How detection works

Each session becomes a trace: what was asked (intent terms), what was done (ordered actions such
as inspect CI, install dependencies, patch, run tests, inspect the diff), normalized commands,
file categories and outcome. Copies, resumed sessions and quick retries count once. Traces are
compared on intent (0.40), action sequence (0.30), commands and tools (0.15), file categories
(0.10) and repository (0.05), then clustered. Intent compares the requests' words (stemmed terms,
phrases and a small concept lexicon); with the optional model (`reflex model fetch`) it also compares
their meaning, so "make the login page load faster" and "the sign-in screen is really slow" match. A cluster becomes a suggestion only if it has at
least 3 independent sessions with consistent behavior; one-offs, read-and-answer sessions and
generic "read, edit, test" patterns are not suggested.

The skill contains only steps seen in at least half the sessions, in the order they usually
happened, with example commands that recurred and passed a safety filter. Corrections you gave in
follow-up messages ("don't change the CI workflow") become constraints when the same correction
appears in at least 2 sessions; only the words those sessions share are kept. No transcript excerpts.
Details: [docs/architecture.md](docs/architecture.md).

## Measuring a skill

Each suggestion shows what the workflow costs today: median tokens and tool calls per run. When you
approve it, Reflex keeps that as the baseline. After you've used the skill, run `reflex scan` and
`reflex impact <name>`. Reflex finds the sessions that loaded the skill (a `Skill` call, or the agent
reading its `SKILL.md`) and compares their medians with the baseline. It reports a change only when
both sides have at least 3 runs, and never predicts savings in advance.

- Tokens are whole-session totals as Claude Code and Codex record them, cache reads included, so
  other work in the same session counts too.
- Cursor doesn't record tokens. Cursor runs count tool calls only.
- The skill's own cost is shown as an estimate from its file size (4 characters per token).

## Routing tasks to models

The router groups your priced Claude Code and Codex sessions by kind of task (review, CI, debugging,
features and tests, edits, research, questions) and compares the models you used on each: average
cost at API list prices and how often the session needed fixing (your corrections, failed tool calls
and repeated commands, per request). The pick is the cheapest model with at least 3 sessions that
needed fixing about as rarely as the most reliable one; with less evidence the kind is LEARNING.

```bash
reflex run --dry-run "the CI job is failing on main, fix it"   # the pick and why
reflex run "the CI job is failing on main, fix it"             # starts claude/codex on it (asks first)
reflex route                                                   # picks, trials, bench results
```

`reflex run` decides before any work happens: your most similar past sessions vote on the kind of
task (by meaning too, with the optional model), then it starts the agent with `--model`. One model
per session, so prompt caching is unaffected. Nothing sits between you and the agent. Your request
goes to the agent as typed and is never stored; Reflex keeps the kind, tool, model and time of the
run so a later scan can find the session it started. Next to the pick it shows what a session on
that model usually costs you. When the agent exits it asks one optional question, "Did it get the
job done?" (Enter skips, `--no-ask` turns it off); the answer is stored with the run and is the
strongest evidence the trials have.

Past sessions alone can't say whether a cheaper model would have done as well, because you choose
models by how hard the task looks. Two ways to get fair evidence:

- **Exploration** (`reflex route explore 10`, off by default): on about 10% of runs, chosen at
  random, `reflex run` tries the model you have used least on that kind of task among the ones you
  already use with that tool. `reflex route` compares explored and picked runs from the same coin
  flips. `--protect review ci` keeps kinds of task out of it.
- **Bench** (`reflex bench "<task>" --models sonnet opus --check "pnpm test" --setup "pnpm install"`):
  the same task on each model, each in a fresh clone of the current repository's last commit,
  scored by your check command. Non-persistent Claude Code sessions with project settings only, so
  bench runs never show up in your history. Each run uses your Claude account; before you confirm,
  bench estimates the cost from your average session on each model.

Cursor isn't routed: it records no tokens to compare, and its editor takes no model from outside.

## Privacy and security

- Transcripts are read locally and treated as data, never as instructions.
- Reflex makes no network connections; outgoing sockets are blocked in-process. The one exception is
  `reflex model fetch`, which you run explicitly to download the optional embedding model (pinned
  files, verified by SHA-256). It reads no transcripts and uploads nothing; scans stay offline.
- Secrets, emails, home paths and your user name are redacted before anything is stored or shown.
- Scans are incremental: a transcript that has not changed since the last scan is not opened again.
  Redacted traces are kept after their transcript is deleted (by you, or by the agent's own cleanup),
  so history can reach further back than the agent keeps it. `reflex reset` deletes them.
- It reads only known agent history folders (or ones you pass), after asking.
- Nothing is written outside `~/.reflex` until you install: per target with `reflex install`, or into every
  detected agent with `space` in `reflex tui`. Installs never overwrite; removals delete only unchanged copies Reflex wrote.

Threat model and mitigations: [docs/security.md](docs/security.md).

## Sources and targets

| | Reads history from | Installs skills to | Status |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/*/*.jsonl` | `~/.claude/skills/<name>/SKILL.md` | Parser tested on fixtures matching real files; skill use verified with `validate --run` |
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` | `~/.codex/skills/<name>/SKILL.md` | Parser follows the Codex protocol types and is tested on fixtures; not yet run against real rollouts or a live Codex session |
| Cursor | `~/.cursor/projects/*/agent-transcripts/*/*.jsonl` | `~/.cursor/skills/<name>/SKILL.md` | Parser tested on fixtures and on real agent transcripts. Cursor doesn't record tool results, so pass/fail outcomes aren't available for its sessions |

**Conductor.** Conductor runs its own Claude Code and Codex, which save sessions to `~/.claude` and
`~/.codex` like any other session, so Reflex reads them with those sources. A session whose folder is
a Conductor workspace (`~/conductor/workspaces/<repo>/<workspace>`) counts toward `<repo>`, not
toward each workspace, and `reflex sessions` marks it "via Conductor". `reflex doctor` shows whether
the workspace folder exists. Cursor and OpenCode sessions run through Conductor are not read yet.

Override locations with `REFLEX_CLAUDE_DIR`, `REFLEX_CODEX_DIR`, `REFLEX_CURSOR_DIR`, `REFLEX_CONDUCTOR_DIR`,
`REFLEX_CLAUDE_SKILLS_DIR`, `REFLEX_CODEX_SKILLS_DIR`, `REFLEX_CURSOR_SKILLS_DIR` and `REFLEX_HOME`. `REFLEX_DEBUG=1` prints local counters (counts only).

## Walkthrough

[docs/demo.md](docs/demo.md) walks through the loop on your own history.

## Development

```sh
pnpm build       # bundles the CLI to apps/cli/dist/reflex.js
pnpm test        # vitest across all packages
pnpm typecheck
pnpm lint
```

The monorepo uses pnpm workspaces and Turborepo with strict TypeScript, Zod for untrusted records,
and built-in `node:sqlite` for storage, so there are no native dependencies. The optional embedding
model runs on onnxruntime-web's WebAssembly backend for the same reason. Packages live in
`packages/*`; the CLI in `apps/cli`. `packages/test-fixtures` holds synthetic transcripts used only
by the tests; it is not part of the published CLI.

## Limitations

- Confidence is a ranking heuristic, not a probability.
- Without the model, intent matching uses stemmed TF-IDF plus a small built-in lexicon. Requests worded
  with no words in common need `reflex model fetch` to match.
- The embedding model (all-MiniLM-L6-v2) is English-only and does not know developer jargon as well as
  the lexicon ("GitHub Actions is red" vs. "CI is failing"), so it is combined with word matching,
  never used alone. Clusters found only by meaning may get a generic name.
- Each source reads at most its 2,000 most recent files per scan.
- Sponsor integrations (Alike, Darwin) are not included: no public API documentation was available
  to build against, and the product works without them.
