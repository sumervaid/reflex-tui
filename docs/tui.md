# Terminal UI

`reflex tui` (or `reflex` on its own, in a terminal) is a full-screen view of what Reflex has stored
locally: the last scan's sessions and token counts, the skills it generated or wants you to review,
the workflows behind them, and a search over every scanned session. It reads nothing new on its
own, except the first lines of a Claude Code transcript to find the folder to resume it in. The
only writes are the ones you ask for with `space` (install or remove a skill) and `r` (scan again
the way you last scanned); enter in Search hands the terminal to `claude` or `codex`.

## Run it

```sh
reflex scan --days 7     # choose what Reflex may read; the UI shows the result of the last scan
reflex                   # same as `reflex tui`; without a terminal it prints help
```

It needs an interactive terminal (`reflex tui needs an interactive terminal` otherwise) of at least
80×24. The layout is designed for 150×45 and stays readable at 120×40. From 140 columns the sidebar
shows full names and summaries; below that it is a narrow rail.

## Views

| Key | View | What it shows today |
| --- | --- | --- |
| `0` | Dashboard | Sessions in the scan window, and NEEDS A LOOK (new suggestions, retired skills still installed) |
| `1` | Morning | Yesterday's sessions and context/output tokens, new and retired skills, where skills are installed, what Reflex reads |
| `2` | Tokens | The scan window: token identity (fresh input, cache writes, cache reads, output), cache hit rate, sessions per tool, tokens per day |
| `3` | Skills | Generated skills and pending suggestions, with the SKILL.md in a scrollable preview |
| `4` | Workflows | Every repeated workflow the last analysis found (rejected ones left out), with its evidence: sessions, repositories and tools, confidence, median tokens, tool calls and duration, each step with how many sessions had it, recurring corrections, uncertainty and the sessions themselves. `space` approves or installs its skill, or removes it |
| `5` | Router | Suggestions only. Sessions with a priced model, grouped by kind of task (from what the agent did: review, CI, debugging, features and tests, edits, research, questions). For each model: sessions, average cost and how often it needed fixing (your corrections, failed tool calls and immediately repeated commands, per request). The pick is the cheapest model with 3+ sessions within 0.05 of the most reliable; with fewer sessions the verdict is LEARNING. `space` turns autopilot on or off: on, `reflex run` starts on the pick without asking |
| `6` | Search | Each scanned session's redacted opening request (`you`, turn 1) and its normalized steps (`ai`, turns 2..), with the session's cost and request count. `tab` filters by tool; enter resumes a Codex session with `codex resume <id>`, a Claude Code session with `claude --resume <id>` in the folder it ran in, and opens a Cursor chat's workspace with `cursor <folder>` (or the Cursor app on macOS); the chat is in Cursor's agent history |

## Keys

| Key | Action |
| --- | --- |
| `0`-`6` | Switch view |
| `↑` `↓` / `j` `k` | Move the selection in a list |
| `space` / `enter` | Skills: install a new or uninstalled skill, remove an installed one |
| `r` | Rescan in the background; the top bar shows `rescanning…` until it finishes |
| `b` | Full sidebar or rail (needs 140+ columns) |
| `m` | Agent memory on or off (live data only). Morning's MEMORY line and the sidebar show what new sessions are told |
| `q`, `ctrl-c` | Quit |
| `/`, `tab` | Search; for now they answer `search is not available yet` |

Clicks work on sidebar items and list rows, and the mouse wheel scrolls preview panes.

## What `space` does in Skills

On a new item (a pending suggestion), Reflex approves it exactly like `reflex approve`: it writes
`~/.reflex/skills/<name>/SKILL.md` and records the workflow's cost as the baseline. It never
replaces a copy there that you edited; then it changes nothing and says
`kept <name>: edited since Reflex generated it`. Then it installs the skill into every detected
agent (`~/.claude/skills`, `~/.codex/skills`, `~/.cursor/skills`, or the `REFLEX_*_SKILLS_DIR`
overrides):

- nothing there: written with exclusive create and recorded;
- an identical copy already there: counted as installed and recorded;
- a different skill with the same name: left alone and reported,
  `installed <name> · skipped codex (a different skill exists)`.

On an installed item, Reflex removes each copy it recorded, but only a regular file at
`<target>/<name>/SKILL.md` whose sha256 still matches the record. It removes the per-skill folder
if that leaves it empty, then drops the record. A copy you edited stays, with its record:
`kept <name> in claude: edited since install`. Symlinks are never followed or deleted.

## Rescan

`r` runs this same CLI as a child process: `scan --yes --days <n>` with the last scan's window and
one `--source` for each source it read, so it only repeats what you already agreed to. When it
finishes the views reload and a message says `rescanned: 1,291 sessions, 7 new` (new = session ids
the previous scan did not have). Without a previous scan it says
``run `reflex scan` first to choose what Reflex may read``. A scan that used `--claude-dir`,
`--codex-dir` or `--cursor-dir` is not repeated, because those folders are not recorded.

## Live data and what is not measured

The views draw one value, `TuiData` (`packages/tui/src/model.ts`). The live source
(`packages/tui/src/live/source.ts`) fills only what Reflex records today. A missing block shows its
heading and `not measured yet`; a missing value inside a block shows `—`.

| Data | Live today | Source |
| --- | --- | --- |
| Last scan time, session count | yes | latest row of `scans` |
| Sessions per tool | yes | the scan's per-source counts (claude, codex, cursor) |
| History folders read, install folders | yes | adapters' roots for the sources the scan read; detected targets |
| Tokens for the window, per day, yesterday | yes | `usage` on stored traces; days by session start in local time. Each session id counts once. Yesterday only when the scan covers all of it |
| Skills: new, retired, installed, support, steps, preview | yes | `suggestions`, `skills`, `installations`; SKILL.md read from disk (64 KB cap, no symlinks) or generated in memory for pending items |
| Needs a look | yes | new suggestions; retired skills still installed |
| Cost in dollars: today, yesterday, month, all scanned, per day, tool, model and project, cache savings, most expensive sessions | yes | `usageByModel` on stored traces at API list prices (`packages/core/src/pricing.ts`). Unknown models and Cursor (no tokens) are unpriced. A session's cost counts on the day it started; the daily series ends yesterday. "Most expensive prompts" are the opening requests of the most expensive sessions |
| Budget | no | no budget setting, so no budget line |
| Usage limits and pace | not measured | no plans file |
| Workflows: support, steps, evidence, installed | yes | `suggestions` (pending and approved), their skills' installation records; a workflow installs as its skill, so it has no `runAs` and is not counted again as an installed workflow |
| Router | yes | priced sessions by kind of task and main model (the one that cost the most); see the Router row above. Autopilot: the `reflex run` setting (`reflex route autopilot`) |
| Search | yes | stored traces: `excerpt` and `displaySteps`, each session once. Raw transcripts are not stored, so later prompts and replies are not searchable |
| Resume | Claude Code, Codex, Cursor (workspace) | native session id from the trace; Claude's folder from the `cwd` in the first 256 KB of its transcript (no symlinks); a Cursor chat's workspace from the folder its transcript sits in |

Cursor records no tokens, so a day with only Cursor sessions has no token value.

## Design sources

The layout comes from the Claude Design handoff in `docs/design/tui-v5/`: `HANDOFF.md`, the
prototype `reference/agentlens-tui-v5.dc.html` (its script block is the layout in code) and exact
character dumps in `mockups/` at 150×45 and 120×40. The renderer in `packages/tui/src/render/`,
`views/` and `shell.ts` ports the prototype's helpers line by line. The only intended difference is
the brand in the top bar: ` ◆ Reflex AI ` where the design says ` ◆ agentlens ` (same width).

## Golden tests

`packages/tui/test/golden/reference-150x45.json` and `reference-120x40.json` hold every cell of all
seven views (text, colors, bold) as the prototype itself draws them. They were produced by running
the prototype's own `compose()` in a sandbox, and they match the mockup dumps cell for cell.
`packages/tui/test/golden.test.ts` renders the design fixture (`packages/tui/fixture/design.ts`)
through the shell and compares every cell; `test/views/*.test.ts` do the same per view and also
render the empty and live-shaped data (`fixture/live-shape.ts`).

To regenerate the reference after the design changes:

```sh
pnpm --filter @reflex/tui reference
```

Do not edit the reference files by hand.

## Dev preview

```sh
pnpm tui:preview
pnpm --filter @reflex/tui preview -- --clock 08:14:07 --view skills
```

The preview runs the TUI on the design fixture with simulated actions, so every view is full. The
fixture lives in `packages/tui/fixture/`, outside `src/`; nothing in `src/` imports it and it is
not part of the CLI bundle.

## Filling more of TuiData

Each `not measured yet` block is an optional field the views already draw in full: the design
fixture sets all of them. To bring one to life:

1. Record the measurement in the backend (a package under `packages/`, stored in `~/.reflex`).
2. Set the field in `loadLive` (`packages/tui/src/live/source.ts`). Labels are pre-formatted in the
   design's style (`10 Oct`, `sat 10 oct`), and every string from transcripts, files or paths goes
   through `toCells`.
3. For features with actions, implement them in the live source: `toggleItem("workflows", ...)`,
   `setAutopilot`, or `resume`, which returns the command that reopens a session in its own CLI.
4. Add the field to the live-mapping test in `apps/cli/test/tui.test.ts`.

| Field | Type | Fills |
| --- | --- | --- |
| `money` | `Money` | today, all time, month to date, daily budget |
| `limits`, `plansFile` | `ToolLimits[]` | Dashboard limit cards and the sidebar summary |
| `days[].usd`, `days[].byTool` | `Day` | Morning and Dashboard charts, Tokens daily cost |
| `window.usd`, `byModel`, `byProject` | `TokenWindow` | Tokens cost split and bar lists |
| `topPrompts`, `topSessions` | `PromptRow[]`, `SessionRow[]` | Tokens tables |
| `workflows` | `ItemList` | Workflows view, Morning columns |
| `router` | `Router` | Router view, Morning router line |
| `search` | `SearchIndex` | Search view; `query` runs on every render, so it must be fast |
