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
| `scan --days <n>` | Ask per source, then read and store redacted workflow traces. `--claude-dir`, `--codex-dir`, `--cursor-dir`, `--yes` |
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
| `stats` | Counts from local data |
| `reset` | Delete Reflex's own data (not installed skills) |

Prompts default to No. Without a terminal, nothing is read or written unless you pass `--yes`.

## How detection works

Each session becomes a trace: what was asked (intent terms), what was done (ordered actions such
as inspect CI, install dependencies, patch, run tests, inspect the diff), normalized commands,
file categories and outcome. Copies, resumed sessions and quick retries count once. Traces are
compared on intent (0.40), action sequence (0.30), commands and tools (0.15), file categories
(0.10) and repository (0.05), then clustered. A cluster becomes a suggestion only if it has at
least 3 independent sessions with consistent behavior; one-offs, read-and-answer sessions and
generic "read, edit, test" patterns are not suggested.

The skill contains only steps seen in at least half the sessions, in the order they usually
happened, with example commands that recurred and passed a safety filter. No transcript text.
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

## Privacy and security

- Transcripts are read locally and treated as data, never as instructions.
- Reflex makes no network connections; outgoing sockets are blocked in-process.
- Secrets, emails, home paths and your user name are redacted before anything is stored or shown.
- It reads only known agent history folders (or ones you pass), after asking.
- Nothing is written outside `~/.reflex` until you install, per target, without overwriting.

Threat model and mitigations: [docs/security.md](docs/security.md).

## Sources and targets

| | Reads history from | Installs skills to | Status |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/*/*.jsonl` | `~/.claude/skills/<name>/SKILL.md` | Parser tested on fixtures matching real files; skill use verified with `validate --run` |
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` | `~/.codex/skills/<name>/SKILL.md` | Parser follows the Codex protocol types and is tested on fixtures; not yet run against real rollouts or a live Codex session |
| Cursor | `~/.cursor/projects/*/agent-transcripts/*/*.jsonl` | `~/.cursor/skills/<name>/SKILL.md` | Parser tested on fixtures and on real agent transcripts. Cursor doesn't record tool results, so pass/fail outcomes aren't available for its sessions |

Override locations with `REFLEX_CLAUDE_DIR`, `REFLEX_CODEX_DIR`, `REFLEX_CURSOR_DIR`,
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
and built-in `node:sqlite` for storage, so there are no native dependencies. Packages live in
`packages/*`; the CLI in `apps/cli`. `packages/test-fixtures` holds synthetic transcripts used only
by the tests; it is not part of the published CLI.

## Limitations

- Confidence is a ranking heuristic, not a probability.
- Intent matching uses a small built-in lexicon plus TF-IDF, with no embeddings or LLM calls. Unusual
  vocabulary may need more sessions to cluster.
- Each source reads at most its 2,000 most recent files per scan.
- Sponsor integrations (Alike, Darwin) are not included: no public API documentation was available
  to build against, and the product works without them.
