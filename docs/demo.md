# Walkthrough

This runs Reflex on your own Claude Code, Codex and Cursor history. Everything stays on your machine.

Install once (Node.js 22.13 or newer):

```sh
npm install -g reflex-skills
```

## 1. See what Reflex can find

```sh
reflex doctor
```

It lists the history folders it found and how many transcript files they hold. Nothing is read
yet.

## 2. Scan

```sh
reflex scan --days 30
```

It asks before reading each source; prompts default to No. You'll see how many sessions were
analyzed, how many were duplicates (copies, resumed sessions, quick retries), and how many repeated
workflows were found.

## 3. Review

```sh
reflex suggest
```

Each suggestion shows how many independent sessions and repositories it came from, the typical
steps and how often each one appeared. Press **e** for the evidence: the redacted request,
actions and outcome of every session behind it. Press **r** to reject it, **a** to approve.

Nothing appears? Reflex only suggests a workflow you have done at least 3 times in separate
sessions. Try a longer window, come back after more sessions, or lower the bar with
`reflex settings matching --sessions 2 --strictness looser`.

## 4. Approve

Approving writes `~/.reflex/skills/<name>/SKILL.md` and prints it. Read it: it contains steps,
completion criteria and provenance, not transcript text. Nothing is installed yet.

## 5. Install

Reflex offers to install right away. Press space on each agent you use (Claude Code, Codex, Cursor), then Enter. It shows
the destination and asks before writing. It never overwrites an existing skill. Later:

```sh
reflex install <name>
```

## 6. Use it

Open a new Claude Code, Codex or Cursor agent session in a repository and give it a task like the ones in the
evidence. The agent picks up installed skills at session start.

## 7. Look back

```sh
reflex explain <name>   # which sessions and repositories the skill came from
reflex skills           # what's generated and where it's installed
reflex stats            # counts only
reflex reset            # delete Reflex's own data (installed skills are kept)
```
