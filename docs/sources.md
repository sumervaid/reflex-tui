# Sources and targets

| | Reads history from | Installs skills to | Status |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/projects/*/*.jsonl` | `~/.claude/skills/<name>/SKILL.md` | Parser tested on fixtures matching real files; skill use verified with `validate --run` |
| Codex | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` | `~/.codex/skills/<name>/SKILL.md` | Parser follows the Codex protocol types and is tested on fixtures; not yet run against real rollouts or a live Codex session |
| Cursor | `~/.cursor/projects/*/agent-transcripts/*/*.jsonl` | `~/.cursor/skills/<name>/SKILL.md` | Parser tested on fixtures and on real agent transcripts. Cursor doesn't record tool results, so pass/fail outcomes aren't available for its sessions |

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

Codex history is found through `CODEX_HOME` when it is set. `REFLEX_REDACT_USER` adds a user name to
redact. All variables: [architecture.md](architecture.md#configuration).

Each source reads at most its 2,000 most recent files per scan.
