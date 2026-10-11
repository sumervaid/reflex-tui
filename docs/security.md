# Security

Transcripts are untrusted data. Reflex reads them, it never obeys them.

| Risk | What Reflex does |
| --- | --- |
| **Prompt injection** | Transcript text is only tokenized, classified and counted. Skill titles, descriptions and steps come from fixed templates and a family catalog; request text never reaches a skill. A hostile workflow repeated across sessions is covered by tests. |
| **Shell injection** | Reflex never executes transcript content. Example commands in skills must recur in two sessions, are normalized (`<n>`, `<file>`, `<ref>`), and are dropped if they contain shell metacharacters (`` ` $ ; & \| < > \ ``) or anything destructive, privileged or remote (`rm`, `sudo`, `curl`, `push`, `--force`, `reset --hard`, `npx`, …). Outward-facing steps (push, commit, post review) say "only if the user asked". |
| **Network** | None. Outgoing sockets are blocked in-process at startup, which covers `fetch`, `http` and `tls`. `validate --run` starts Claude Code as a separate process, after asking, on a fixed prompt in a disposable repo. |
| **Secrets** | Redacted at parse time, before storage or display: private keys, `*_KEY/TOKEN/SECRET/PASSWORD/URL=` assignments, auth headers, bearer tokens, connection strings, URL credentials, provider key formats (Anthropic, OpenAI, AWS, GitHub, Slack, Google, Stripe, npm), JWTs, emails, high-entropy strings, home paths and the user name. Generated skills are redacted again and refused if a leak check finds anything. |
| **Permissions** | `scan` shows locations and file counts without reading, then asks per source. Without a TTY, every prompt defaults to No unless `--yes` is passed. `install` asks per target and shows the destination. |
| **Overwrite** | Generation writes only inside `~/.reflex`. Installs use exclusive create (`O_EXCL`), so an existing skill is never replaced; you can view a diff, pick another name or cancel. Re-approving asks before replacing a Reflex copy you edited. `reset` deletes only files Reflex created. |
| **Path traversal and malicious filenames** | Skill names must match `^[a-z0-9][a-z0-9-]{0,47}$`. Destinations are checked to stay inside their target folder. Transcript filenames are never used to build write paths. |
| **Symlinks** | Discovery skips symlinks. Writes use `O_NOFOLLOW`, and Reflex refuses a symlinked home folder or skill folder. |
| **Scope** | Only known agent history folders (or folders you pass) are read, at a fixed depth and filtered by name. Reflex never walks your home directory. |
| **Denial of service** | Files are streamed line by line. Lines over 4 MB are skipped, sessions are capped at 3,000 events and 40 requests, and each source is capped at its 2,000 most recent files. Malformed lines are skipped and counted. |
| **Local data** | `~/.reflex` is mode 0700 and the database 0600. It stores redacted traces and short excerpts, not raw transcripts. Debug logging (`REFLEX_DEBUG=1`) prints counts only. |

Not covered: a local attacker who already has your user account, and what the coding agent
does with a skill after you install it. Read a skill (`reflex show-skill`) before installing it.
