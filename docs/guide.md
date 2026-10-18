# Reflex guide

How Reflex finds repeated workflows, matches requests, improves the skills you already have, measures them and routes tasks to models. The [README](../README.md) has the overview and commands; this guide has the details.

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
Cursor chat's workspace in Cursor. Cursor saves no tokens in its transcripts, so its sessions have
no cost unless you turn on `reflex cursor-usage` (below); if you allow it, Reflex reads which model
each Cursor chat used and Tokens counts Cursor sessions per model. Usage
limits are not recorded, so that block says `not measured yet`. Run `reflex scan` again (or press
`r`) after upgrading: costs need the model of each session, which older scans did not store.

In Skills, `space` on a new suggestion approves it and installs it into every detected agent;
`space` on an installed skill removes the copies Reflex wrote, unless you edited them. `r`
repeats the last scan with the same window and sources. `q` quits. Details: [tui.md](tui.md).

## How detection works

Each session becomes a trace: what was asked (intent terms), what was done (ordered actions such
as inspect CI, install dependencies, patch, run tests, inspect the diff), normalized commands,
file categories and outcome. Copies, resumed sessions and quick retries count once. Traces are
compared on intent (0.40), action sequence (0.30), commands and tools (0.15), file categories
(0.10) and repository (0.05), then clustered. Intent compares the requests' words (stemmed terms,
phrases and a small concept lexicon) in any language: Japanese, Chinese and Thai are split into
words, Korean particles are stripped (배포를 → 배포), filler words are dropped (published lists plus
everyday fillers, `casual-stopwords.ts`) and words your own history uses across unrelated kinds of
work are quieted, more so as the history grows; with the optional model (`reflex model fetch`) it also compares
their meaning, so "make the login page load faster", "the sign-in screen is really slow" and
"로그인 화면이 너무 느려" match. A cluster becomes a suggestion only if it has at
least 3 independent sessions with consistent behavior; one-offs, read-and-answer sessions and
generic "read, edit, test" patterns are not suggested.

`reflex settings matching` changes that bar: `--sessions` from 2 to 5, and `--strictness looser` or
`stricter`, which lowers or raises the clustering and intent thresholds together by 0.05. A short
history may need `--sessions 2 --strictness looser`; a long one whose suggestions are too broad,
`--strictness stricter`. A change redoes the last scan's suggestions at once, and a suggestion found
at settings other than the defaults says so in `reflex suggest` and `reflex show`.

The skill contains only steps seen in at least half the sessions, in the order they usually
happened, with example commands that recurred and passed a safety filter. Corrections you gave in
follow-up messages ("don't change the CI workflow") become constraints when the same correction
appears in at least 2 sessions; only the words those sessions share are kept. No transcript excerpts.
Details: [architecture.md](architecture.md).

## Matching by meaning: which model

Matching by words always runs. A local embedding model adds matching by meaning; it is optional and
runs on your machine (WebAssembly, no native code, no network after the download).

| | `reflex model fetch` (default) | `reflex model fetch --light` |
| --- | --- | --- |
| Model | bge-m3, int8 | all-MiniLM-L6-v2, int8 |
| Reads | 100+ languages, and requests that mix them | English (Latin script); other text is matched by words only |
| Download | 587 MB | 23 MB |
| Memory while embedding | about 2.8 GB | about 0.6 GB |
| Time per session, 1 / 4 threads | about 2.9 s / 0.8 s | about 0.09 s / 0.03 s |

Measured on Apple silicon with real-length requests; older CPUs can be up to about 3x slower. The
`Embedding benchmark` workflow (`.github/workflows/embedding-bench.yml`; on pull requests that change embedding or matching code, by hand, and weekly)
measures load time, time per request and peak memory for both models on Linux (x64 and ARM),
Windows and macOS (Intel and Apple silicon), and checks matching quality is the same everywhere;
locally: `REFLEX_PERF=bge-m3 REFLEX_TEST_MODELS=~/.reflex/models pnpm vitest run packages/analysis/test/eval/perf.test.ts`. On
English requests MiniLM matches at least as well as bge-m3, so English-only users lose nothing with
`--light`. Embedding uses up to 4 cores (`REFLEX_EMBED_THREADS` to change). Before downloading,
`model fetch` estimates the first scan's time from your stored sessions and recommends `--light`
on machines with under 8 GB of memory or fewer than 4 cores. Each scan spends at most
`--embed-minutes` (default 5) embedding, newest sessions first, and the next scan continues; a
machine without memory for the model skips it with a warning. Vectors are cached per model, so
`reflex model use <name>` switches without re-embedding what either model already did.

## Skills you already have

If most sessions of a repeated workflow already loaded skills you wrote, Reflex does not suggest a
new skill for it; `reflex scan` says which of your skills handle it instead. Only skills specific to
that workflow count (loaded at least twice as often there as in your other sessions), so general
guidance you load everywhere never hides a suggestion. Skill folders that are symlinks into a
skills repo are followed: Reflex reads and edits the real `SKILL.md`, so changes show up in that
repo's `git status`. `--dry-run` shows the review, the proposal and the check without writing.

`reflex improve <skill>` compares one of your skills with the sessions that loaded it (at least 2).
The rule is that a skill keeps producing the same thing; improving it means getting there faster
or cheaper.

- **What it never touches.** Your text is never edited: Reflex only appends a marked "Learned from
  your sessions" section (replaced on the next run, never duplicated). Sections whose heading names
  the output (`Output format`, `Response`, `Template`, `Report`, …) and anything between
  `<!-- reflex:fixed:start -->` and `<!-- reflex:fixed:end -->` are treated as the output contract:
  the appended section says to keep them exactly, and nothing proposed may write a summary or
  correct the format.
- **Proposed by default: faster.** Commands that worked in those sessions for steps your skill
  already names, so the agent doesn't work them out again.
- **Shown, not written: cheaper.** If a cheaper model was about as reliable on those sessions,
  `reflex improve` says so; `reflex run` uses it. The skill file isn't changed for that.
- **Opt-in with `--behavior`: changes what the agent does.** Steps most sessions took that the
  skill doesn't mention, and corrections you repeated. Steps the skill names that rarely happened
  are reported; Reflex never removes a step.
- **Checked before it's applied.** `--verify "<a task this skill handles>"` runs that task with the
  current and the proposed skill, each in a fresh copy of the current repository (non-persistent
  Claude Code sessions on your account), and compares the shape of the two answers: headings,
  tables, lists, labels, JSON keys. Values such as times and names may differ; the format may not.
  If it changed, the edit is not applied (`--force` overrides). Answers are compared in memory and
  never saved.
- **Recorded.** Every proposal is attached to the skill in Reflex's database: fingerprints before
  and after, what was proposed, the check result, whether you applied it and where the backup is.
  `reflex improve <skill> --history` lists them. Your file changes only if you confirm; the previous
  version goes to `~/.reflex/backups`.

A session counts as using a skill when the agent called it (Claude Code's `Skill` tool) or read
its `SKILL.md`.

## Measuring a skill

Each suggestion shows what the workflow costs today: median tokens and tool calls per run. When you
approve it, Reflex keeps that as the baseline. After you've used the skill, run `reflex scan` and
`reflex impact <name>`. Reflex finds the sessions that loaded the skill (a `Skill` call, or the agent
reading its `SKILL.md`) and compares their medians with the baseline. It reports a change only when
both sides have at least 3 runs, and never predicts savings in advance.

- Tokens are whole-session totals as Claude Code and Codex record them, cache reads included, so
  other work in the same session counts too.
- Cursor saves no tokens in its transcripts. Cursor runs count tool calls only, unless
  `reflex cursor-usage` was on during them.
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

Cursor isn't routed: `reflex run` can't choose the model for Cursor's editor, so the router only
compares Claude Code and Codex sessions.

## Prices

Costs are what the same tokens would cost on the Anthropic or OpenAI API at list prices, not what a
subscription charges. The built-in prices were checked on 11 Oct 2026; the Tokens view and
`reflex route` show that date. Claude Code's cache writes are priced by how long they are cached:
5-minute writes at 1.25x the input price, 1-hour writes at 2x.

A model Reflex has no price for is left out of every cost and named as an unknown model in the
Tokens view and `reflex route`. To add one, or to correct a price that has changed, create
`~/.reflex/prices.json` with dollars per million tokens:

```json
{
  "my-new-model": { "input": 5, "output": 25, "cacheWrite": 6.25, "cacheRead": 0.5, "cacheWrite1h": 10 },
  "acme-*": { "input": 1, "output": 4, "cacheWrite": 1, "cacheRead": 0.1 }
}
```

Keys are model ids, or prefixes ending in `*`, and come before the built-in prices. `cacheWrite1h`
is optional; without it, 1-hour writes cost the same as `cacheWrite`. An entry with a missing or
negative price is skipped, with a warning when Reflex starts.

## Sources in detail

**What Cursor sessions lack.** Cursor records less than Claude Code and Codex: no token counts
unless the hook below was on (so its other sessions have no cost, in the TUI, `impact` and bench
estimates), no command results (so no pass/fail, and a session never counts as "recovered from a
failure"), and no times for the steps of agents a chat launched (they are placed right after the
launch). These come from Cursor's data, not from Reflex; `reflex doctor` lists them too.

**Cursor token usage.** Cursor's transcripts and app database have no token counts (every
`tokenCount` is 0), but Cursor passes each agent turn's counts to its hooks. `reflex cursor-usage on`
adds one hook (`stop`, with `afterAgentResponse` as fallback) that appends the chat and turn ids, the
model and the four token counts to `~/.reflex/cursor-usage.jsonl`; never the prompt or the answer, no
network. The chat id is the transcript's file name, so `reflex scan` attaches those counts to each
Cursor chat and prices them like other sessions. Only turns from while the hook is on are counted;
Cursor's command-line agent in `-p` mode sends no end-of-turn hook. Not available on Windows yet.

**Agents a session launched.** When a Cursor chat launches agents (its `Task` / `Subagent` tool),
Reflex records each one (kind, model, background or not, its short description) and reads the
agents' transcripts (`<chat>/subagents/*.jsonl`). Their commands, files and tool calls count toward
the chat's workflow; the message each agent was given is written by the parent agent, so it is
never treated as your request. `reflex agents` lists the chats that launched the most, and
`reflex sessions` notes the count. Claude Code's agents are not read yet.

**Conductor.** Conductor runs its own Claude Code and Codex, which save sessions to `~/.claude` and
`~/.codex` like any other session, so Reflex reads them with those sources. A session whose folder is
a Conductor workspace (`~/conductor/workspaces/<repo>/<workspace>`) counts toward `<repo>`, not
toward each workspace, and `reflex sessions` marks it "via Conductor". `reflex doctor` shows whether
the workspace folder exists. Cursor and OpenCode sessions run through Conductor are not read yet.

Override locations with `REFLEX_CLAUDE_DIR`, `REFLEX_CODEX_DIR`, `REFLEX_CURSOR_DIR`, `REFLEX_CONDUCTOR_DIR`,
`REFLEX_CLAUDE_SKILLS_DIR`, `REFLEX_CODEX_SKILLS_DIR`, `REFLEX_CURSOR_SKILLS_DIR` and `REFLEX_HOME`. `REFLEX_EMBED_THREADS` sets the embedding threads. `REFLEX_DEBUG=1` prints local counters (counts only).

## Limitations

- Confidence is a ranking heuristic, not a probability.
- Without the model, intent matching uses stemmed TF-IDF plus a small built-in lexicon (English).
  Requests worded with no words in common, or asked in different languages, need
  `reflex model fetch` to match.
- Embedding models do not know developer jargon as well as the lexicon ("GitHub Actions is red" vs.
  "CI is failing"), so they are combined with word matching, never used alone. With the light
  model, requests in other scripts (Korean, Japanese, ...) are matched by words only. Clusters
  found only by meaning may get a generic name.
- Each source reads at most its 2,000 most recent files per scan.
- Long-context rates (Haiku 5.5 above 100K prompt tokens) aren't modeled; those prompts are priced
  at the standard rate.
- Sponsor integrations (Alike, Darwin) are not included: no public API documentation was available
  to build against, and the product works without them.
