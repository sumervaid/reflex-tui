# Handoff: agentlens TUI

## Overview
agentlens is a local-only terminal app. It reads the coding-agent transcripts already on a developer's laptop (Claude Code, Codex, Cursor) and turns them into:
- an exact cost meter
- usage-limit gauges
- auto-generated skills and workflows
- a model router
- full-text search over every turn

Nothing leaves the machine. The user opens it in a tmux pane in the morning, scans it for 30 seconds, toggles a few things and quits.

**The backend already exists.** Build the TUI on top of it: the transcript indexer, pricing, skill/workflow mining, router policy and installers. Read the existing backend first, map every data field below to an existing function or model, and only add backend code where something is genuinely missing (see "Backend gaps to check").

## About the design files
`reference/agentlens TUI v5.dc.html` is an **HTML prototype** that simulates the terminal cell by cell. It is a design reference, not code to port. Recreate it in **Python + Textual** (the stack named in the original brief) using the app's existing patterns.

`mockups/agentlens-150x45.txt` and `mockups/agentlens-120x40.txt` are exact character dumps of all 7 views at both target sizes, generated from the prototype. **Treat them as the source of truth for layout, copy and column widths.** All numbers in them are mock data.

To run the prototype, open the `.dc.html` next to `support.js` in a browser. Keys work as described below, and clicking sidebar items and rows works too.

## Fidelity
**High fidelity.** Final layout, copy, glyphs and colors. Every color is an exact xterm-256 entry, so it renders identically without truecolor.

## Global constraints
- Target 150×45 cells. Must stay readable at 120×40.
- Dark background. Color is reserved for state:
  - green: enabled / new / good
  - yellow: updated / over budget / ≥70% of a limit
  - red: retired / ≥90% of a limit
  - dim: unchanged
- No emoji. Box drawing, block elements (`▁▂▃▄▅▆▇█ ▏▎▍▌▋▊▉ ░▒▓ ▀▄`), `● ○ ◆ ▌ ▸ ╌ ⋮` are allowed.
- No modal dialogs. No mouse requirement (but clicks should work). Preview panes scroll.
- Tables truncate with `…`. They never wrap. Long prompts are pre-truncated to the column width.

## App shell

```
┌ TopBar (1 row, bg #303030) ──────────────────────────────────────────────────┐
│ [◆ agentlens] <view name, bold>  [<key>]                scanned HH:MM  HH:MM:SS │
├ Sidebar (30 cols, bg #262626) ┬ View (1-col padding each side) ───────────────┤
│                               │ ContentSwitcher: dashboard | morning | tokens  │
│                               │   | skills | workflows | router | search       │
├ StatusBar (1 row, bg #303030) ┴───────────────────────────────────────────────┤
│ key chips (bg #4e4e4e, bold #eeeeee) + labels       ● local · offline (dim)   │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Widget tree (suggested):**

```
AgentLensApp(App)                       ENABLE_COMMAND_PALETTE = False
├── TopBar(Static)
├── Horizontal#main
│   ├── Sidebar(Static or Vertical)     width 30 | 3 (rail)
│   └── ContentSwitcher#views (initial="dashboard")
│       ├── DashboardView   ├── MorningView   ├── TokensView
│       ├── ItemsView#skills ├── ItemsView#workflows
│       ├── RouterView      └── SearchView
└── StatusBar(Static)
```

The content area has one blank row of top padding, so view line 0 is screen row 2.

### Sidebar
The sidebar has two modes:
- **Full (30 cols):** when the terminal is ≥140 cols. `b` toggles full ↔ rail.
- **Rail (3 cols):** always below 140 cols. Pressing `b` there toasts "sidebar needs 140+ columns".

Full layout, top to bottom:
1. ` LENSES` (dim, bold), then ` local only · 1,284 sessions` (dim), then a blank row.
2. Seven items in this order. Each item is 3 rows: title, summary, blank.
   - `0 Dashboard`, `1 Morning`, `2 Tokens`, `3 Skills`, `4 Workflows`, `5 Router`, `6 Search`.
   - Title row: `▌` (selected only, #eeeeee), the key (dim), then the name (bold; #eeeeee if selected, else #d0d0d0).
   - Right edge of the title row: an attention dot `●` (see below).
   - Selected item: rows get bg #3a3a3a.
3. Summary line for each item (indented 5):
   - Dashboard: `opus 83% · today $12.40` (83% in the limit color)
   - Morning: `$41.27  +32% vs avg` (delta yellow if up, green if down)
   - Tokens: `$968.40 · last 30 days`
   - Skills / Workflows: `N new · N upd · N ret` (green / yellow / red)
   - Router: `N switches · autopilot on|off`
   - Search: `/ 41,208 turns indexed`
4. ` INSTALLED` block: `N skills · N workflows`, then `autopilot on|off`.
5. Pinned to the bottom: ` nothing leaves this machine` (dim), then ` ~/.local/share/agentlens` (#585858).

**Attention dots.** A view gets a dot until it has been viewed in this run. Dot colors:
- Dashboard yellow if any limit is ≥70%
- Morning yellow if yesterday was above the 7-day average
- Skills / Workflows green if anything is new
- Router yellow if a recommendation changed
- Tokens and Search: never

Keep a `seen: set[view_id]` and add to it on every switch. The opening view starts as seen.

**Rail mode:** ` ◆`, then for each item: `▌` (if selected), the key, and the dot. One item every 2 rows.

## Keys

| Key | Action |
|---|---|
| `0`–`6` | Switch view. Opens on **0 Dashboard**. |
| `/` | Go to Search and start typing. |
| `↑ ↓` / `j k` | Move the selection (Skills, Workflows, Router, Search). |
| `space` / `enter` | Skills/Workflows: install or remove. Router: autopilot on/off. Search: resume the session. |
| `tab` | Search: cycle the tool filter `all → claude → codex → cursor`. |
| `esc` | Search: leave typing mode. |
| `r` | Rescan, non-blocking. |
| `b` | Toggle sidebar full/rail. |
| `q` | Quit. |

In Search typing mode, all printable keys go to the query, Backspace deletes, `↑↓` still move, and Enter/Esc leave typing.

**Rescan** runs as `@work(thread=True, exclusive=True)`. While it runs, the top bar shows `rescanning…` in yellow. When it finishes, it rebuilds every view and toasts `rescanned: N sessions, M new`.

**Toasts** appear bottom-right, 44 cols wide and 3 rows tall, above the status bar. They have bg #303030 and a left bar `▌` in the state color, and auto-dismiss after 3 s. Any toggle also refreshes the sidebar counts and the Morning/Dashboard "installed" numbers.

**Status bar chips by view:**
- Dashboard / Morning / Tokens: `0-6 jump · / search · r rescan · b sidebar · q quit`
- Skills / Workflows / Router: same, plus `↑↓ select · space toggle|autopilot`
- Search: `0-6 jump · / type · ↑↓ results · tab tool · enter resume · esc done`

## Views
Exact text and positions are in the mockup files. Below: purpose, structure, and the data each view needs. "W" means the content width:
- 118 at 150 cols with the full sidebar
- ~115 at 120 cols with the rail

The prototype switches to compact copy and column variants when W < 140, so at both target sizes you are effectively building the compact variant. Keep both variants if you want to support wider terminals.

### 0 Dashboard (opening view)
Purpose: one consolidated screen covering usage limits, money and what needs attention.

1. **USAGE LIMITS** heading (bold), then dim helper text.
2. Three boxed cards side by side (rounded border #444444, 10 rows high), one per CLI tool. Title: `claude · Max 5x`, `codex · Pro`, `cursor · Pro`. Each card contains:
   - The highest limit's % in **big digits** (3 rows) in its limit color. Beside it: `<limit> used`, `resets <when>`, `highest of N`.
   - One bar per limit: label (8 cols plus a space), then `█` for used (#8a8a8a if <70%, otherwise the limit color) and `░` for the rest (#585858), then the bold %, then the reset time right-aligned.
   - A pace line at the bottom, yellow if the user is on pace to hit the limit before it resets. Example: `hits opus limit Wed 16:00`.
   - Under the cards, in #585858: `plans in ~/.config/agentlens/plans.toml · red at 90%, yellow at 70%`.
3. **KPI strip**, 6 columns. Each has a dim bold label, a bold value and a dim sub-line:
   - TODAY
   - YESTERDAY (sub-line `+32% vs usual` in yellow)
   - 30 DAYS
   - ALL TIME
   - CACHE SAVED (green)
   - ROUTER `$114/mo` (green)
4. Two columns:
   - Left, **NEEDS A LOOK**: up to 5 rows of `● <sentence>` with the dot in the state color and the jump key `[3]` right-aligned in dim.
   - Right, **LAST 14 DAYS BY TOOL**: a stacked vertical bar chart, 2-cell bars with a 1-cell gap. The shading is the legend: `█` claude, `▓` codex, `░` cursor. Bars are #8a8a8a; yesterday's bar is #d0d0d0. Height is `max(6, min(12, h-22))` rows. Bottom labels: first date and `yday`.

**Data:** a per-tool list of limits `{name, used_pct, resets_at, pace_hits_at|None}`; plan per tool; today/yesterday/30d/all-time USD; cache-saved USD; router monthly saving; per-day per-tool USD for 14 days; attention items `{severity, text, target_view}`.

### 1 Morning
Purpose: what changed since yesterday.

1. **Hero row.**
   - Left: `YESTERDAY   sat 10 oct`, then a blank row, then **big digits** `$41.27` (#eeeeee) and 4 spaces of gap, then big `+32%` (yellow if up, green if down).
   - Below that: `above your 7-day average of $31.27 by $10.00`, then `23 sessions  18.4M context  312k output tokens`, then `all time $4,735.80 since 14 Mar  this month $246.40`.
   - Right: an 8-day vertical bar chart using eighth blocks. The baseline is `floor(min*0.8/5)*5`, not zero, so the difference shows. There's a `╌` line at the 7-day average with y labels (max / avg / base); yesterday's bar is in the delta color, the others #585858. Day labels sit below the chart.
2. **Three horizontal bar lists**, each with a bold title, then name, bar (`█` plus a fractional eighth, #8a8a8a) and right-aligned USD:
   - `by cli tool` (claude, codex, cursor)
   - `by model` (top 5)
   - `by project` (top 5)
3. **Three state columns: NEW / UPDATED / RETIRED.**
   - Header: bold count plus the label in the state color, then a `━` rule in the state color.
   - Rows: `skill`/`wf` (dim), the name (workflows prefixed `/wf-`), and `N sess` (dim).
   - Cap at 8 rows, then `+N more`.
4. `ROUTER  debug  opus-4-1 -> gpt-5-codex` (new model in green; multiple separated by 5 spaces).
5. `ACTIVE  N skills + N workflows  in ~/.claude/skills ~/.claude/commands ~/.codex/prompts`.
6. `DATA  ~/.local/share/agentlens  reads ~/.claude/projects ~/.codex/sessions`.

### 2 Tokens
Purpose: the bill, readable by a non-engineer.

1. `LAST 30 DAYS   11 sep – 10 oct   612 sessions   all time $4,735.80`.
2. Big digits `$968.40`. Beside them, three comparison rows:
   - `paid` bar vs `without caching` bar (#585858), with values.
   - `caching saved  $2,246.50` (green, bold) `70% off the uncached price`.
3. **Full-width stacked bar, 2 rows**, showing where the money went. Segments are shaded `█ output · ▓ cache reads · ▒ cache writes · ░ fresh input`. Below it, a legend with the USD and % for each segment.
4. Two identity lines (dim, with numbers in #d0d0d0):
   - `context 412.6M tok = fresh input 28.3M + cache writes 31.9M + cache reads 352.4M, plus output 7.9M`
   - `cache hit rate 85.4% … output share 1.9% of tokens, 38% of cost`
5. **CLI TOOLS** block: one row per tool with name, sessions, cost-share bar, 30-day USD, share %, all-time USD. The header columns are built from the same widths as the rows.
6. **DAILY COST** (28 days):
   - Vertical bars, 10 rows tall, 2-cell columns at 120 / 3-cell at 150.
   - Bars are yellow when over the $40 budget, otherwise #8a8a8a. A `╌` line marks the budget.
   - y labels for max / $40 / $0. x labels every 7 days, with the last one right-aligned.
   - Below: a `tok/d` sparkline (#585858).
   - Header line: `max $X on <date>   [avg $Y]   N days over $40` (the count in yellow).
   - Right of the chart: `by model` and `by project` hbar lists.
7. **MOST EXPENSIVE PROMPTS** and **MOST EXPENSIVE SESSIONS**.
   - Each row: USD, a 10-cell bar, then fields.
   - Prompts: project, the human message.
   - Sessions: date, source, project, task class, turns, tools, context, opening prompt.
   - Show N rows each, where `N = clamp((remaining_rows-3)/2, 2, 6)`.

**Data:** 30-day totals and the token identity components; uncached-equivalent cost; per-day USD and tokens; by model; by project; by tool (30d and all-time); top prompts; top sessions.

### 3 Skills and 4 Workflows (same layout)
1. **Hint line**, compact variant:
   - Skills: `space installs/removes ~/.claude/skills/<name>/SKILL.md + ~/.codex/prompts/<name>.md`
   - Workflows: `space installs ~/.claude/commands/wf-<name>.md (/wf-<name> <task>) + ~/.codex/prompts/wf-<name>.md`
2. **Split 40% / 60%.**
   - Left: a boxed table with the title `skills N · M on` and subtitle `i/N`. Columns: `on` (`●` green / `○` dim, 2 cells wide because they are ambiguous-width), `name` (colored by state), `sup`, `upd`, `st`. Selected row bg #3a3a3a.
   - Right: a boxed, scrollable preview of the generated markdown file. Title is the install path; subtitle is `installed` / `not installed`. Front matter is dim, headings are bold #eeeeee.
3. **Space / Enter** installs or removes both files via the existing installer, toasts `installed <name>` / `removed <name>`, and posts a `Toggled` message so the sidebar, Morning and Dashboard refresh.

### 5 Router (consumer-friendly)
1. **Banner:**
   - Chip ` AUTOPILOT ` (bg #005f00 when on, #3a3a3a when off), then `ON` (green, bold) or `OFF`.
   - `Claude Code picks the model for each prompt you send`, then `space turns off`.
   - Autopilot is the Claude Code `UserPromptSubmit` hook in `~/.claude/settings.json`.
2. **Build line:** `built automatically from 1,284 sessions in your history · 8 kinds of task found · rebuilt 08:02`. The router is rebuilt from transcripts on every scan, with no manual setup.
3. **Hero.**
   - Left: big green digits for the monthly saving, beside `if you follow every pick` and `N switches, M sessions`.
   - Right: **how it decides**, 3 numbered plain-language steps.
4. **YOUR TASKS:** 2 rows per task class, selectable.
   - Row 1: `▸` (if selected), a plain name (Debugging, Refactoring, Writing tests, Migrations, Code review, Writing docs, Infrastructure, Explaining code), the recommended model (green and bold if it differs from most used), the replaced model (dim; hidden in compact), the saving per session, confidence `●●●○○` (`ceil(n/15)` capped at 5) plus `N sessions`, a verdict (`SWITCH` green / `KEEP` / `LEARNING` dim), and `changed today` in yellow.
   - Row 2: a dim reason, e.g. `just as reliable as opus-4-1, 40% cheaper` or `only opus-4-1 has enough sessions so far · try another model…`.
5. **WHY <MODEL> FOR <TASK>:** one row per observed model.
   - Name, cost bar, `$avg`, "needs fixing" bar, the friction value ×10 (`per 10 replies`).
   - Tag: `picked` (green) / `too few sessions (n)` / `less reliable` (yellow) / `reliable, costs more`.
6. **Footer:** `rules ~/.config/agentlens/router-policy.json` and a definition of "needs fixing".

**Policy, unchanged from the backend:** pick the cheapest model whose friction is ≤ best observed + margin (0.05), among models with ≥ min support (8 sessions). Friction = (corrections + tool errors + repeated commands) ÷ assistant turns.

### 6 Search (full-turn search)
1. **Query line:**
   - Chip ` / `, then the query (#eeeeee) with a `▏` cursor while typing. When empty: `press / and type to search every turn`.
   - Right side: `N turns in M sessions · 41,208 turns indexed`.
2. **Tool filter:** `tool  [all]  claude  codex  cursor   tab cycles · …`.
3. **Split 50% / 50%.**
   - Left, boxed **results**: 3 rows per hit (`▸ date tool project  turn N`, then `you`/`ai` plus a snippet starting ~22 chars before the first match, then a blank). Selected bg #3a3a3a. The list scrolls to keep the selection centered. Subtitle `i/N`.
   - Right, boxed **turn N in context**: a header (`tool · project · date`, then `session <id>  N turns  $cost`), then the session's matched turns in order with `⋮ N turns` gap markers. The current turn has a `▌` bar on the left. Optional `files` line.
   - Matches are highlighted bold #eeeeee on bg #5f5f00 everywhere.
   - Subtitle: `enter resumes in <tool>`.
4. **Enter** resumes the session at that turn in its own CLI (`claude --resume <id>`, `codex resume <id>`, `cursor-agent --resume <id>`). In the prototype this only toasts the command. In the real app, use `app.suspend()` and exec it, or print it, whichever the backend supports.

**Data:** an FTS index over every turn `{session_id, tool, project, date, turn_no, role, text}`. SQLite FTS5 is fine. Sort by date desc, then turn desc. Debounce the query by ~100 ms.

## Big digits (3 rows, half-block font)
Every glyph is a 6-pixel-high bitmap. Each text row combines 2 pixel rows: `█` both, `▀` top, `▄` bottom, space neither. Glyphs are separated by 1 space. `#` means on.

```
0 .##. #..# #..# #..# #..# .##.     5 #### #... ###. ...# ...# ###.
1 .#.  ##.  .#.  .#.  .#.  ###      6 .##. #... ###. #..# #..# .##.
2 .##. #..# ...# ..#. .#.. ####     7 #### ...# ..#. .#.. .#.. .#..
3 ###. ...# .##. ...# ...# ###.     8 .##. #..# .##. #..# #..# .##.
4 #..# #..# #..# #### ...# ...#     9 .##. #..# #..# .### ...# .##.
$ ..#.. .#### #.#.. .###. ..#.# ####.
. .  .  .  .  .  #       , .  .  .  .  #  #
% #..# ...# ..#. .#.. #... #..#     + ... .#. ### .#. ... ...    - ... ... ### ... ... ...
```

## Chart helpers (port these)
- **hbar(v, max, width):** `floor` full `█`, plus one partial from `▏▎▍▌▋▊▉█` for the remainder ×8.
- **vchart(values, rows, col_w):** for each row from the top, `level = round(v/max*rows*8) - (rows-1-r)*8`. Then `█` if ≥8, `' ▁▂▃▄▅▆▇█'[level]` if 1–7, otherwise blank. Each bar is `col_w-1` cells plus a 1-cell gap. An optional reference line draws `╌` in empty cells at its row.
- Render with `rich.text.Text` segments. Pre-truncate with `Text.truncate(width, overflow="ellipsis")`.

## Design tokens (xterm-256 exact)

| Token | Hex | 256 | Use |
|---|---|---|---|
| bg | #1c1c1c | 234 | screen |
| sidebar | #262626 | 235 | sidebar bg |
| bar | #303030 | 236 | top bar, status bar, toast |
| sel | #3a3a3a | 237 | selected row |
| key | #4e4e4e | 239 | key chips |
| line | #444444 | 238 | box borders |
| faint | #585858 | 240 | tertiary text, empty bar cells |
| dim | #808080 | 244 | labels, unchanged |
| gb | #8a8a8a | 245 | neutral bars |
| fg | #d0d0d0 | 252 | body text |
| hi | #eeeeee | 255 | emphasis, numbers |
| ok | #87d787 | 114 | enabled / new / good |
| warn | #d7af5f | 179 | updated / over budget / ≥70% |
| bad | #d75f5f | 167 | retired / ≥90% |
| autopilot | #005f00 | 22 | AUTOPILOT chip bg when on |
| match | #5f5f00 | 58 | search highlight bg |

Borders are `round`. Text is bold only for headings, values and selection. The prototype is monospace at 13.5px with 15px rows.

## Backend gaps to check
Map each of these to existing code and add only what's missing:
1. **Cursor ingestion:** the reader for `~/.cursor/chats/**` (path assumed) and its pricing.
2. **Usage limits:** `plans.toml` (plan per tool), rolling 5-hour and weekly windows (Claude also tracks a weekly Opus limit), Cursor monthly allowance, reset times, and a pace projection (linear on the current window).
3. **Per-tool aggregates:** daily, 30-day and all-time.
4. **Turn-level FTS index** and the resume command per tool.
5. **Router build metadata:** sessions used, classes found, last rebuilt, and `changed today` (diff against yesterday's policy).
6. **Attention feed:** `{severity, text, target_view}` for the Dashboard.

## Files
- `mockups/agentlens-150x45.txt`: all 7 views, exact characters.
- `mockups/agentlens-120x40.txt`: same at 120×40, with the rail sidebar.
- `reference/agentlens TUI v5.dc.html` and `reference/support.js`: interactive prototype. The view renderers (`dashboard`, `morning`, `tokens`, `itemsTab`, `router`, `search`, `sidebar`, `compose`) in its script block are the layout spec in code form, including every width calculation.
