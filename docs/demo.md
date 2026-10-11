# Demo script (4 to 5 minutes)

## Before you go on stage

```sh
pnpm install && pnpm build
alias reflix="node $PWD/apps/cli/dist/reflix.js"
export REFLIX_HOME=/tmp/reflix-demo          # clean slate, nothing from rehearsals
export REFLIX_CLAUDE_SKILLS_DIR=/tmp/reflix-demo-claude-skills   # optional: keep your real ~/.claude untouched
reflix reset --yes 2>/dev/null; claude --version   # the last step needs a signed-in Claude Code
```

Use a terminal at least 110 columns wide. The demo history is a sanitized fixture set: 28
sessions over the last week, across 5 repositories, from both Claude Code and Codex. It includes
copies, a resumed session, a retry, a corrupted file, one-off tasks and a prompt-injection attempt.

## Script

**0:00 · The problem (20 s)**
"Every week I explain the same CI-fixing routine to my coding agent. The knowledge is already in
my history, it just never becomes reusable. Reflix finds those repeats and turns them into skills,
locally."

**0:20 · Doctor (20 s)**
```sh
reflix doctor
```
Point out: it found Claude Code history by location and file count only, and read nothing. Reflix
makes no network connections; that is enforced in-process.

**0:40 · Scan (40 s)**
```sh
reflix scan --days 7 --demo
```
It asks per source before reading, defaulting to No; press **y** for each. Point out: 28 sessions became 25 independent ones
(a copy, a resumed session and a retry are counted once), one corrupted file was partially
recovered, and **0 bytes uploaded**.

**1:20 · Suggestions and evidence (70 s)**
```sh
reflix suggest
```
Three workflows. One-off tasks and "explain why CI failed" (similar words, read-only behavior)
were not suggested. Open `fix-ci` and press **E** for evidence:
- Six sessions, three repositories, four Claude Code and two Codex, worded differently ("CI is
  failing after pnpm install", "check why github actions is failing on PR #41").
- `NPM_TOKEN=[REDACTED]`: secrets are removed before anything is stored or shown.
- The typical workflow and how many sessions showed each step.

**2:30 · Approve (30 s)**
Press **A**. The skill is generated into `~/.reflix/skills/fix-ci/SKILL.md` and printed: 51 lines,
nine steps from consensus, completion criteria, provenance metadata, and no transcript text.
"Nothing was installed yet."

**3:00 · Install (20 s)**
Reflix offers to install. Press space on Claude Code, then Enter. It shows the destination and
that no file exists there, then asks; press **y**. Back in the review, press **q** to finish.
Running it again would say "already installed and identical"; a different file with the same name
is never overwritten.

**3:20 · Prove it on a new task (60 s)**
```sh
reflix validate fix-ci --run
```
It creates a fresh repository whose CI fails with a bug none of the six sessions saw (a config
value read as a string, so `retries + 1` becomes `"31"`), installs the skill project-locally,
and runs a non-persistent Claude Code session with restricted tools. It takes about 25 seconds.
Point out:
- `Skill invoked yes · Skill(fix-ci)`.
- The agent followed the routine: repository state, reproduce, smallest fix, tests, diff, summary.
- `Tests now pass yes`.

**4:20 · Why it exists (20 s)**
```sh
reflix explain fix-ci
reflix stats
```
Every skill traces back to local session references. Stats are counts only.

**4:40 · Close**
"Your history, your machine, your approval at every step."

## If something goes wrong

- **No network or Claude Code not signed in:** run `reflix validate fix-ci` without `--run`. It
  prints the fresh repository path and the exact prompt so you can run `claude` there by hand.
- **The terminal isn't interactive** (some screen-sharing setups): use `reflix suggest
  --no-interactive`, then `reflix evidence fix-ci`, `reflix approve fix-ci`, and
  `reflix install fix-ci --target claude-code`. Pass `--yes` to answer prompts.
- **Start over:** `reflix reset --yes`.
