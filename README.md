# Reflix

Reflix finds the workflows you keep re-explaining to Claude Code and Codex, and turns the ones
you have really repeated into reusable skills. It runs entirely on your machine.

```
scan history → find repeats across ≥ 3 independent sessions → show evidence
            → you approve → SKILL.md in ~/.reflix/skills → you install → a fresh agent session uses it
```

## Quick start

Requires Node.js 22.13 or newer and pnpm.

```sh
pnpm install && pnpm build && pnpm test
alias reflix="node $PWD/apps/cli/dist/reflix.js"

reflix doctor                 # what Reflix can see, without reading anything
reflix scan --days 7 --demo   # sanitized demo history; drop --demo to scan your own (asks first)
reflix suggest                # review suggestions: [a]pprove, [e]vidence, [r]eject
reflix install fix-ci         # copy the skill into Claude Code and/or Codex (asks per target)
reflix validate fix-ci --run  # prove it on a fresh task in a fresh Claude Code session
```

## Commands

| Command | What it does |
| --- | --- |
| `doctor` | Node and SQLite check, detected history locations and file counts, install targets, agent CLIs |
| `scan --days <n>` | Ask per source, then read and store redacted workflow traces. `--demo`, `--claude-dir`, `--codex-dir`, `--yes` |
| `sessions` | Sessions from the last scan, redacted |
| `suggest` | Detect repeated workflows and review them interactively (`--no-interactive`, `--all`) |
| `show <n\|name>` | A suggestion in detail: steps, support, uncertainty |
| `evidence <n\|name>` | The sessions behind a suggestion: redacted request, actions, outcome, source |
| `approve <n\|name>` | Generate `~/.reflix/skills/<name>/SKILL.md` (at most 150 lines) |
| `reject <n\|name>` | Stop suggesting it |
| `skills` | Generated skills and where they are installed |
| `show-skill <name>` | Print a generated skill |
| `install <name>` | Install into Claude Code or Codex. `--target`, `--as <new-name>`, `--yes`. Never overwrites |
| `explain <name>` | Why the skill exists: sessions, repositories, agents, steps, installs |
| `validate <name>` | Static checks, installed-copy comparison, and a fresh-task sandbox (`--run` starts Claude Code) |
| `stats` | Counts from local data |
| `reset` | Delete Reflix's own data (not installed skills) |

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

## Privacy and security

- Transcripts are read locally and treated as data, never as instructions.
- Reflix makes no network connections; outgoing sockets are blocked in-process.
- Secrets, emails, home paths and your user name are redacted before anything is stored or shown.
- It reads only known agent history folders (or ones you pass), after asking.
- Nothing is written outside `~/.reflix` until you install, per target, without overwriting.

Threat model and mitigations: [docs/security.md](docs/security.md).

## Sources and targets

| | Reads history from | Installs skills to | Status |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/*/*.jsonl` | `~/.claude/skills/<name>/SKILL.md` | Parser tested on fixtures matching real files; skill use verified with `validate --run` |
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` | `~/.codex/skills/<name>/SKILL.md` | Parser follows the Codex protocol types and is tested on fixtures; not yet run against real rollouts or a live Codex session |

Override locations with `REFLIX_CLAUDE_DIR`, `REFLIX_CODEX_DIR`, `REFLIX_CLAUDE_SKILLS_DIR`,
`REFLIX_CODEX_SKILLS_DIR` and `REFLIX_HOME`. `REFLIX_DEBUG=1` prints local counters (counts only).

## Demo

[docs/demo.md](docs/demo.md) is a 4 to 5 minute script. The demo history is generated from
sanitized fixtures in `packages/test-fixtures` and goes through the same pipeline as real
history. It covers three recurring workflows (fix CI, review a PR, debug a dependency), plus
near-misses, one-offs, duplicates, a corrupted file and a prompt-injection attempt.

## Development

```sh
pnpm build       # bundles the CLI to apps/cli/dist/reflix.js
pnpm test        # vitest across all packages
pnpm typecheck
pnpm lint
```

The monorepo uses pnpm workspaces and Turborepo with strict TypeScript, Zod for untrusted records,
and built-in `node:sqlite` for storage, so there are no native dependencies. Packages live in
`packages/*`; the CLI in `apps/cli`.

## Limitations

- Confidence is a ranking heuristic, not a probability.
- Intent matching uses a small built-in lexicon plus TF-IDF, with no embeddings or LLM calls. Unusual
  vocabulary may need more sessions to cluster.
- Each source reads at most its 2,000 most recent files per scan.
- Sponsor integrations (Alike, Darwin) are not included: no public API documentation was available
  to build against, and the product works without them.
