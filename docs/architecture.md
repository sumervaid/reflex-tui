# Architecture

Reflix is a local CLI. It reads coding-agent history you point it at, and writes only inside its
own folder until you explicitly install a skill.

```mermaid
flowchart LR
  A[Claude Code JSONL<br/>Codex rollouts] -->|adapters: stream, validate, redact| B[NormalizedSession]
  B -->|trace| C[WorkflowTrace]
  C -->|dedup| D[Independent instances]
  D -->|similarity + clustering + gates| E[Suggestions]
  E -->|you approve| F[~/.reflix/skills/name/SKILL.md]
  F -->|you install, per target| G[~/.claude/skills<br/>~/.codex/skills]
  F -->|validate --run| H[Fresh Claude Code session<br/>in a disposable repo]
```

## Packages

| Package | Responsibility |
| --- | --- |
| `@reflix/core` | Session model (`NormalizedSession`, `SessionEvent`, `WorkflowTrace`), adapter interface, hashing, debug counters |
| `@reflix/safety` | Redaction, leak detection, path containment, slug validation, no-follow/exclusive file writes |
| `@reflix/adapters` | Claude Code and Codex parsers: detection, permission prompt, bounded discovery, streaming parse |
| `@reflix/analysis` | Command classification, traces, de-duplication, similarity, clustering, consensus steps, suggestions |
| `@reflix/storage` | SQLite (`node:sqlite`) store in `REFLIX_HOME` (default `~/.reflix`) |
| `@reflix/skills` | SKILL.md generation, validation, diffs, install planning, fresh-task sandbox |
| `@reflix/test-fixtures` | Synthetic transcripts in the real on-disk layouts, for tests only (not bundled) |
| `apps/cli` | Commands and prompts (`commander`, `@clack/prompts`), bundled into one file with tsup |

Internal packages export TypeScript source; only the CLI is built.

## Adapters

Each adapter implements `detect` (location and file count, no reads), `requestPermission`,
`discover` (fixed depth, no symlinks, mtime window) and `parse` (stream line by line, Zod-validate,
skip bad lines, cap line size and events per session).

- Claude Code: `~/.claude/projects/<encoded-cwd>/<session>.jsonl`. `user`/`assistant` records with
  string or block content (`text`, `tool_use`, `tool_result`). Sidechain, meta, harness-injected and
  duplicate-uuid records are dropped.
- Codex: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`. `{timestamp, type, payload}` lines:
  `session_meta`, `response_item` (messages, `shell`/`exec_command` calls, `local_shell_call`,
  `apply_patch`, outputs with exit codes), `event_msg`. The parser follows the Codex protocol types;
  it has been tested on fixtures, not on real rollouts (no Codex history on the development machine).

All text is truncated and redacted inside the adapter, before anything else sees it.

## From sessions to suggestions

1. **Trace.** Each session becomes an ordered list of action categories (`inspect-ci`,
   `install-dependencies`, `modify-dependencies`, `run-tests`, `inspect-diff`, …), normalized
   commands (`gh run view <n> --log-failed`), file categories, outcome signals (failure then
   recovery, verification after the change) and intent terms from the user's requests.
2. **De-duplicate.** Byte-identical copies (same fingerprint), resumed sessions (≥ 80% event overlap)
   and quick retries (same repo within 4 hours, similar intent and actions) count once.
3. **Similarity.** Weighted: intent 0.40, action sequence 0.30, commands and tools 0.15, file
   categories 0.10, repository 0.05. Intent blends TF-IDF with a small concept lexicon so
   "GitHub Actions is red" and "CI is failing" match. Action similarity mixes exact sequence
   (LCS, Jaccard) with coarse classes (inspect, change, verify).
4. **Cluster.** Average-linkage agglomerative clustering, threshold 0.45.
5. **Gates.** A cluster becomes a suggestion only with ≥ 3 independent sessions, intent cohesion
   ≥ 0.2, action cohesion ≥ 0.5, and a non-generic trace (≥ 3 distinct actions). Read-and-answer
   sessions and generic "read, edit, test" behavior do not pass.
6. **Consensus.** Steps seen in at least half the sessions, ordered by pairwise precedence (A before B
   if most sessions containing both did A first). Different kinds of patch collapse into one
   "patch the root cause" step with the observed variants. Example commands must recur in two
   sessions and pass a safety filter.
7. **Rank.** Confidence is a heuristic over cohesion, instance count, repository spread, step
   consensus and verification rate. It is shown as a ranking signal, not a probability.

A small family catalog (`fix-ci`, `review-pr`, `debug-dependency`, …) names clusters. It never
creates or admits one.

## Skills

`approve` writes `~/.reflix/skills/<name>/SKILL.md`: frontmatter (`name`, `description`,
provenance metadata with short session references), when to use, numbered consensus steps,
completion criteria and notes. No transcript excerpts. The file is redacted again, checked for
leaks and kept at 150 lines or fewer.

`install` copies it into `~/.claude/skills/<name>/` or `~/.codex/skills/<name>/` only after a
per-target confirmation, never overwriting. `validate --run` creates a fresh git repository with a
bug none of the historical sessions saw, installs the skill project-locally, and runs a
non-persistent Claude Code session with restricted tools to show the skill being invoked and the
tests passing.

## Storage

`~/.reflix/reflix.db` (mode 0600, directory 0700): scans, redacted traces, suggestions and their
status, generated skills and installations. `PRAGMA user_version` gates schema changes.

## Configuration

| Variable | Purpose |
| --- | --- |
| `REFLIX_HOME` | Reflix data folder (default `~/.reflix`) |
| `REFLIX_CLAUDE_DIR`, `REFLIX_CODEX_DIR`, `CODEX_HOME` | Transcript locations |
| `REFLIX_CLAUDE_SKILLS_DIR`, `REFLIX_CODEX_SKILLS_DIR` | Install targets |
| `REFLIX_DEBUG=1` | Local counters on stderr (counts only, never content) |
| `REFLIX_REDACT_USER` | Extra user name to redact |
