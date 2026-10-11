# Walkthrough

This runs Reflix on your own Claude Code and Codex history. Everything stays on your machine.

## 1. See what Reflix can find

```sh
npx reflix doctor
```

It lists the history folders it found and how many transcript files they hold. Nothing is read
yet.

## 2. Scan

```sh
npx reflix scan --days 30
```

It asks before reading each source; prompts default to No. You'll see how many sessions were
analyzed, how many were duplicates (copies, resumed sessions, quick retries), and how many repeated
workflows were found.

## 3. Review

```sh
npx reflix suggest
```

Each suggestion shows how many independent sessions and repositories it came from, the typical
steps and how often each one appeared. Press **e** for the evidence: the redacted request,
actions and outcome of every session behind it. Press **r** to reject it, **a** to approve.

Nothing appears? Reflix only suggests a workflow you have done at least 3 times in separate
sessions. Try a longer window, or come back after more sessions.

## 4. Approve

Approving writes `~/.reflix/skills/<name>/SKILL.md` and prints it. Read it: it contains steps,
completion criteria and provenance, not transcript text. Nothing is installed yet.

## 5. Install

Reflix offers to install right away. Press space on Claude Code and/or Codex, then Enter. It shows
the destination and asks before writing. It never overwrites an existing skill. Later:

```sh
npx reflix install <name>
```

## 6. Use it

Open a new Claude Code or Codex session in a repository and give it a task like the ones in the
evidence. The agent picks up installed skills at session start.

## 7. Look back

```sh
npx reflix explain <name>   # which sessions and repositories the skill came from
npx reflix skills           # what's generated and where it's installed
npx reflix stats            # counts only
npx reflix reset            # delete Reflix's own data (installed skills are kept)
```
