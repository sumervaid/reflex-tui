# Routing, improve and impact

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

`--protect` takes these kind names: `review`, `ci`, `debug`, `feature`, `edit`, `research`, `explore`.
