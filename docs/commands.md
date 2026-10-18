# Commands

Every command and its options. `reflex <command> --help` prints the same from the installed version.

| Command | What it does |
| --- | --- |
| `doctor` | Node and SQLite check, detected history locations and file counts, install targets, agent CLIs, Cursor hook |
| `scan --days <n>` | Ask per source, then read and store redacted workflow traces. `--days` defaults to 7. `--source <claude-code\|codex\|cursor>` (repeatable), `--claude-dir`, `--codex-dir`, `--cursor-dir`, `--yes`, `--full` (re-read every file instead of reusing unchanged ones), `--embed-minutes <n>` (most time spent comparing new sessions by meaning; default 5, the rest continue next scan) |
| `sessions` | Sessions from the last scan, redacted |
| `suggest` | Detect repeated workflows and review them interactively: `[a]`pprove, `[e]`vidence, `[r]`eject, `[s]`kip, `[q]`uit (`--no-interactive`, `--all`) |
| `show <n\|name>` | A suggestion in detail: steps, support, uncertainty |
| `evidence <n\|name>` | The sessions behind a suggestion: redacted request, actions, outcome, source |
| `approve <n\|name>` | Generate `~/.reflex/skills/<name>/SKILL.md` (at most 150 lines). `--yes`, `--no-install` (don't offer installation afterwards) |
| `reject <n\|name>` | Stop suggesting it |
| `skills` | Generated skills and where they are installed |
| `show-skill <name>` | Print a generated skill |
| `install <name>` | Install into Claude Code, Codex or Cursor. `--target`, `--as <new-name>`, `--yes`. Never overwrites |
| `explain <name>` | Why the skill exists: sessions, repositories, agents, steps, installs |
| `validate <name>` | Static checks and installed-copy comparison. For `fix-ci`, also a fresh-task sandbox (`--run` starts Claude Code) |
| `impact [name]` | Tokens and tool calls per run before the skill vs. runs that loaded it, plus the skill's own size |
| `tui` | Full-screen terminal UI over the last scan: sessions, tokens, skills to review. `space` installs or removes a skill. Needs an interactive terminal |
| `memory` | What new agent sessions remember: corrections you gave in at least 2 independent sessions. `on` writes a marked block into `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` (refreshed after every scan), `off` removes it, plus `status`, `forget`, `remember` and `add` |
| `run <request>` | Start Claude Code or Codex on the model the router picks for this kind of task. `--dry-run` shows the pick and why, `--tool`, `--model`, `--yes`, `--no-ask`. Asks first unless autopilot is on |
| `route` | The router: picks per kind of task, settings, randomized trials and bench results. `status`, `autopilot on\|off`, `explore <percent>\|off [--protect <kind...>]` |
| `bench <task>` | Run one task on several Claude Code models, each in a fresh copy of the current repository, scored by `--check "<command>"`. `--models`, `--setup`, `--runs`, `--timeout`, `--keep`, `--yes` |
| `improve [skill]` | For skills you already have: lists them with the sessions that loaded each; with a name, compares the skill with those sessions and proposes an edit (asks before reading the skill and before changing it; keeps a backup). `--file`, `--behavior`, `--verify <task>`, `--runs`, `--setup`, `--timeout`, `--force`, `--history`, `--dry-run`, `--yes`. See the [guide](guide.md#skills-you-already-have) |
| `agents` | Sessions that launched agents (Cursor): how many, which kinds, and how many tool calls the agents made |
| `handbook` | How work is done in the current repository, learned from past sessions: commands that worked (and ones that kept failing) and corrections you repeated, with the sessions behind each. `show <id>`, `ask "<question>"`, `export` (Markdown for a teammate, no request text), `--project`, `--all`, `--json`. Read-only, so agents can call it |
| `cursor-usage [on\|off]` | Record Cursor's token counts locally through a Cursor hook. `on` adds Reflex's hook to `~/.cursor/hooks.json` (asks first, keeps your other hooks, backs the file up); `off` removes it. Not available on Windows yet. See the [guide](guide.md#sources-in-detail) |
| `settings matching` | What counts as a repeated workflow: `--sessions <2-5>` (default 3) and `--strictness looser\|default\|stricter`, `--reset`. A change redoes the last scan's suggestions, and each one shows the settings when they aren't the defaults. See the [guide](guide.md#how-detection-works) |
| `stats` | Counts from local data |
| `reset` | Delete Reflex's own data and its Cursor hook (not installed skills or the model). `--yes` |
| `model [status\|fetch\|use\|remove]` | Optional local embedding model for matching requests by meaning. `fetch` downloads bge-m3 (multilingual, 587 MB); `fetch --light` the English-only all-MiniLM-L6-v2 (23 MB); `use <name>` switches between installed ones. See the [guide](guide.md#matching-by-meaning-which-model) |

`reflex` with no command opens the terminal UI in an interactive terminal and prints help otherwise.

Prompts default to No. Without a terminal, nothing is read or written unless you pass `--yes`.

Building from source: [development.md](development.md).
