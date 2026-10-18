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
reflex                    # full-screen terminal UI over the last scan
```

Suggestions need the same kind of task in at least 3 independent sessions. If a week of history
finds nothing, try a longer window (`--days 30`), or match more loosely with
`reflex settings matching --sessions 2 --strictness looser`.

## What it does

- **Skills from your repeats.** Each suggestion shows the sessions behind it. An approved skill
  contains only steps most of those sessions took, commands that recurred and passed a safety
  filter, and corrections you gave more than once. No transcript excerpts.
- **Tokens and cost.** Per day, tool, model and project at API list prices, the most expensive
  sessions, and what caching saved. `reflex impact` compares a workflow before and after its skill.
  Add or correct prices in `~/.reflex/prices.json` ([how](https://github.com/sumervaid/reflex-tui/blob/main/docs/guide.md#prices)).
- **Model routing.** `reflex run` starts Claude Code or Codex on the cheapest model that has been
  about as reliable for that kind of task, and `reflex bench` runs one task on several models.
- **Skills you already have.** `reflex improve` compares one of your skills with the sessions that
  loaded it and proposes an addition. It never edits your text and asks before changing the file.
- **Memory and handbook.** Corrections you repeated can be shared with new agent sessions
  (`reflex memory on`). `reflex handbook` lists the commands that work in a repository.
- **Cursor token counts.** Cursor saves none in its transcripts; `reflex cursor-usage on` records
  them through a Cursor hook from then on.

## Commands

| Command | What it does |
| --- | --- |
| `doctor` | Node and SQLite check, detected history locations and file counts, install targets, agent CLIs, Cursor hook |
| `scan --days <n>` | Ask per source, then read and store redacted workflow traces. `--source <claude-code\|codex\|cursor>` (repeatable), `--claude-dir`, `--codex-dir`, `--cursor-dir`, `--yes`, `--full` (re-read every file instead of reusing unchanged ones), `--embed-minutes <n>` (most time spent comparing new sessions by meaning; default 5, the rest continue next scan) |
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
| `tui` | Full-screen terminal UI over the last scan (also what `reflex` alone opens). Needs an interactive terminal |
| `memory` | What new agent sessions remember: corrections you gave in at least 2 independent sessions. `on` writes a marked block into `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` (refreshed after every scan), `off` removes it, plus `forget`, `remember` and `add` |
| `run <request>` | Start Claude Code or Codex on the model the router picks for this kind of task. `--dry-run` shows the pick and why, `--tool`, `--model`, `--yes`. Asks first unless autopilot is on |
| `route` | The router: picks per kind of task, settings, randomized trials and bench results. `autopilot on\|off`, `explore <percent>\|off [--protect <kind...>]` |
| `bench <task>` | Run one task on several Claude Code models, each in a fresh copy of the current repository, scored by `--check "<command>"`. `--models`, `--setup`, `--runs`, `--timeout`, `--keep`, `--yes` |
| `improve [skill]` | For skills you already have: lists them with the sessions that loaded each; with a name, compares the skill with those sessions and proposes an edit (asks before reading the skill and before changing it; keeps a backup). `--file`, `--yes` |
| `agents` | Sessions that launched agents (Cursor): how many, which kinds, and how many tool calls the agents made |
| `handbook` | How work is done in the current repository, learned from past sessions: commands that worked (and ones that kept failing) and corrections you repeated, with the sessions behind each. `show <id>`, `ask "<question>"`, `export`, `--project`, `--all`, `--json`. Read-only, so agents can call it |
| `cursor-usage [on\|off]` | Record Cursor's token counts locally through a Cursor hook. `on` adds Reflex's hook to `~/.cursor/hooks.json` (asks first, keeps your other hooks, backs the file up); `off` removes it. Not available on Windows yet |
| `settings matching` | What counts as a repeated workflow: `--sessions <2-5>` (default 3) and `--strictness looser\|default\|stricter`, `--reset`. A change redoes the last scan's suggestions, and each one shows the settings when they aren't the defaults |
| `stats` | Counts from local data |
| `reset` | Delete Reflex's own data (not installed skills or the model) |
| `model [status\|fetch\|use\|remove]` | Optional local embedding model for matching requests by meaning. `fetch` downloads bge-m3 (multilingual, 587 MB); `fetch --light` the English-only all-MiniLM-L6-v2 (23 MB); `use <name>` switches between installed ones |

Prompts default to No. Without a terminal, nothing is read or written unless you pass `--yes`.

## Terminal UI

`reflex` on its own (or `reflex tui`) opens seven views over the last scan: Dashboard, Morning,
Tokens, Skills, Workflows, Router and Search (keys `0`-`6`). In Skills, `space` on a suggestion
approves it and installs it into every detected agent, and on an installed skill removes the copies
Reflex wrote. Enter on a Search hit reopens a Claude Code or Codex session, or opens a Cursor
chat's workspace in Cursor. `r` repeats the last scan, `q` quits.
More in the [terminal UI docs](https://github.com/sumervaid/reflex-tui/blob/main/docs/tui.md).

## Privacy and security

- Transcripts are read locally and treated as data, never as instructions.
- Reflex makes no network connections; outgoing sockets are blocked in-process. The one exception is
  `reflex model fetch`, which you run explicitly to download an optional embedding model (pinned
  files, verified by SHA-256). It reads no transcripts and uploads nothing.
- Secrets, emails, home paths and your user name are redacted before anything is stored or shown.
- It reads only known agent history folders (or ones you pass), after asking.
- Redacted traces are kept after their transcript is deleted, so history can reach further back
  than the agent keeps it. `reflex reset` deletes them.
- Nothing is written outside `~/.reflex` until you install a skill, turn on memory or the Cursor
  hook, or apply a `reflex improve` edit, each after asking. Installs never overwrite; removals delete only unchanged copies Reflex wrote.

Threat model and mitigations: [security docs](https://github.com/sumervaid/reflex-tui/blob/main/docs/security.md).

## Supported tools

| | Reads history from | Installs skills to |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/*/*.jsonl` | `~/.claude/skills/<name>/SKILL.md` |
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` | `~/.codex/skills/<name>/SKILL.md` |
| Cursor | `~/.cursor/projects/*/agent-transcripts/*/*.jsonl` | `~/.cursor/skills/<name>/SKILL.md` |

Sessions from Conductor are read through its Claude Code and Codex. Cursor records no tool results,
so pass/fail outcomes aren't available for its sessions. The Codex parser is tested on fixtures, not
yet on real Codex history.

## Limitations

- Confidence is a ranking heuristic, not a probability.
- Without the optional model, requests that share no words, or are asked in different languages,
  don't match; `reflex model fetch` adds matching by meaning.
- Each source reads at most its 2,000 most recent files per scan.

## Learn more

- [Guide](https://github.com/sumervaid/reflex-tui/blob/main/docs/guide.md): how detection works, matching by meaning, improving your skills, measuring a skill, routing tasks to models
- [Walkthrough](https://github.com/sumervaid/reflex-tui/blob/main/docs/demo.md): the loop on your own history
- [Architecture](https://github.com/sumervaid/reflex-tui/blob/main/docs/architecture.md)
- [Development](https://github.com/sumervaid/reflex-tui/blob/main/docs/development.md): building from source and running the tests
- [Issues](https://github.com/sumervaid/reflex-tui/issues)

## License

MIT. See [LICENSE](https://github.com/sumervaid/reflex-tui/blob/main/LICENSE).
