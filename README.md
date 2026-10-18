<!--
  README TEMPLATE NOTES (delete once filled in)
  Sections marked TEMPLATE are commented out until there is something real to put in them:
  logo, community links, related projects, contributors, star history.
  Links and images use full GitHub URLs because this file is also the npm page, where relative
  links would resolve against apps/cli.
-->

<div align="center">

<!-- TEMPLATE: logo. Uncomment once docs/assets/logo.svg exists.
<img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/logo.svg" alt="Reflex logo" width="120">
-->

<h1>Reflex</h1>

<p><b>Reflex finds the workflows you keep re-explaining to Claude Code, Codex and Cursor, and turns them into reusable skills. Runs entirely on your machine.</b></p>

<p>
  <a href="https://www.npmjs.com/package/reflex-skills"><img src="https://img.shields.io/npm/v/reflex-skills?style=flat-square" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/reflex-skills"><img src="https://img.shields.io/npm/dm/reflex-skills?style=flat-square" alt="npm downloads"></a>
  <img src="https://img.shields.io/node/v/reflex-skills?style=flat-square" alt="node version">
  <a href="https://github.com/sumervaid/reflex-tui/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/reflex-skills?style=flat-square" alt="license"></a>
  <a href="https://github.com/sumervaid/reflex-tui/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/sumervaid/reflex-tui/ci.yml?branch=main&style=flat-square&label=CI" alt="CI"></a>
</p>

<p>
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#features">Features</a> ·
  <a href="#terminal-ui">Terminal UI</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#supported-agents">Supported agents</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="#docs">Docs</a>
</p>

<img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/tui-tour.gif" alt="The Reflex terminal UI: dashboard, tokens, skills, workflows, router and search views" width="900">

<sub>The terminal UI, opened with <code>reflex</code>. <a href="#terminal-ui">What each view does</a>. Recorded on the synthetic test history in <code>packages/test-fixtures</code>, not real sessions.</sub>

</div>

## Why Reflex

Coding agents start every session fresh. If you fix CI the same way every week, you explain the same
steps every week: which logs to read, which commands to run, what not to touch.

Reflex reads the session history your agents already keep on disk, finds tasks you have repeated in
at least 3 independent sessions, and writes the steps they had in common into a skill. A skill is a
`SKILL.md` file of reusable instructions; Claude Code, Codex and Cursor pick installed skills up
when a new session starts. You review the evidence and approve each skill before anything is
installed.

## Install

Requires Node.js 22.13 or newer.

```sh
npm install -g reflex-skills   # installs the `reflex` command (the npm name `reflex` is a different package)
```

Or try it without installing. `doctor` shows what Reflex can see without reading anything:

```sh
npx reflex-skills doctor
```

## Quick start

```sh
reflex scan --days 30     # read your Claude Code / Codex / Cursor history (asks first)
reflex suggest            # review suggestions: [a]pprove, [e]vidence, [r]eject
reflex install <name>     # copy an approved skill into Claude Code, Codex and/or Cursor (asks per target)
reflex                    # open the terminal UI over the last scan
```

<img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/quickstart.gif" alt="reflex scan, suggest, approve and install on synthetic history" width="800">

If a short window finds nothing, try a longer one, or match more loosely with
`reflex settings matching --sessions 2 --strictness looser`. [docs/demo.md](https://github.com/sumervaid/reflex-tui/blob/main/docs/demo.md) walks through the
whole loop on your own history.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/how-it-works-dark.svg">
  <img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/how-it-works-light.svg" alt="How Reflex works: your agent history, Reflex finds tasks repeated in at least 3 sessions, you review and approve, the skill is installed, and the next session already knows the steps" width="900">
</picture>

1. **Scan.** Reflex asks per source, then reads your agents' history locally. Secrets, emails, home
   paths and your user name are redacted before anything is stored.
2. **Detect.** Each session becomes a trace of what was asked and what was done. Traces that match
   across at least 3 independent sessions become a suggestion; one-offs never do.
3. **Review.** Each suggestion shows its evidence: the sessions, the steps and how many sessions had
   each one, and corrections you repeated. You approve or reject it.
4. **Install.** An approved skill is written to `~/.reflex/skills` and copied into the agents you
   choose. Installs never overwrite an existing file.

Details: [How detection works](https://github.com/sumervaid/reflex-tui/blob/main/docs/guide.md#how-detection-works).

## Features

- **Skills from your own repeats.** Only steps seen in at least half the sessions, with example
  commands that recurred and passed a safety filter. No transcript excerpts.
- **A terminal UI.** `reflex` opens seven views over your last scan: Dashboard, Morning, Tokens,
  Skills, Workflows, Router and Search. `space` installs or removes a skill. [docs/tui.md](https://github.com/sumervaid/reflex-tui/blob/main/docs/tui.md)
- **Token and cost view.** Tokens from the last scan and what they would cost at API list prices,
  per day, tool, model and project, and what caching saved. Add or correct prices in
  `~/.reflex/prices.json` ([how](https://github.com/sumervaid/reflex-tui/blob/main/docs/guide.md#prices)).
- **A model router and bench.** `reflex run` starts Claude Code or Codex on the cheapest model that
  needed fixing about as rarely as the most reliable one for that kind of task; `reflex bench` runs
  one task on several models and scores them with your check command.
  [Routing tasks to models](https://github.com/sumervaid/reflex-tui/blob/main/docs/guide.md#routing-tasks-to-models)
- **Improve skills you already have.** `reflex improve <skill>` compares a skill with the sessions
  that loaded it and proposes an edit, asking before it reads or changes anything.
- **Memory.** Corrections you gave in at least 2 independent sessions, written as a marked block into
  `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` once you run `reflex memory on`.
- **A handbook per repository.** `reflex handbook` lists the commands that worked in a repository,
  the ones that kept failing and the corrections you repeated, with the sessions behind each.
  Read-only, so agents can call it; `export` writes one for a teammate.
- **Cursor token counts.** Cursor saves none in its transcripts; `reflex cursor-usage on` records
  them through a Cursor hook from then on, so Cursor sessions get a cost too.

## Terminal UI

Run `reflex` after a scan. You can do the whole loop from here (Skills, Workflows), and also see what your agent usage costs and reopen old sessions. Keys `0`-`6` switch views. More: [docs/tui.md](https://github.com/sumervaid/reflex-tui/blob/main/docs/tui.md).

### Skills: review and install

Suggested skills with the `SKILL.md` they would write. `space` approves one and installs it into every agent Reflex detects, or removes it again. The same loop as `reflex suggest` and `reflex install`, in one keypress.

<img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/tui-skills.png" alt="Skills view of the Reflex terminal UI" width="900">

### Workflows: the evidence

Every repeated workflow Reflex found: each step with how many sessions had it, corrections you repeated, cost per run, and the sessions themselves.

<img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/tui-workflows.png" alt="Workflows view of the Reflex terminal UI" width="900">

<details>
<summary><b>More views: Tokens, Router, Search</b></summary>

### Tokens: what your agents cost

Tokens from the last scan and what they would cost at API list prices, per day, tool, model and project, plus how much caching saved and your most expensive sessions.

<img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/tui-tokens.png" alt="Tokens view of the Reflex terminal UI" width="900">

### Router: which model to use

For each kind of task, the cheapest model that needed fixing about as rarely as the most reliable one. `space` turns autopilot on for `reflex run`.

<img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/tui-router.png" alt="Router view of the Reflex terminal UI" width="900">

### Search: find and reopen a session

Every scanned session's opening request and steps. Enter reopens it in Claude Code or Codex, or opens a Cursor chat's workspace.

<img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/tui-search.png" alt="Search view of the Reflex terminal UI" width="900">

</details>

## Commands

| | Command | What it does |
| --- | --- | --- |
| **Find skills** | `reflex doctor` | What Reflex can see: history locations and file counts, install targets. Reads nothing |
| | `reflex scan --days <n>` | Read your agents' history (asks per source) and store redacted traces |
| | `reflex suggest` | Review repeated workflows one by one: approve, see evidence, reject |
| | `reflex show <n>` · `evidence <n>` | One suggestion in detail · the sessions behind it |
| | `reflex approve <n>` · `reject <n>` | Generate its `SKILL.md` · stop suggesting it |
| **Install** | `reflex install <name>` | Copy a skill into Claude Code, Codex and/or Cursor. Never overwrites |
| | `reflex skills` · `show-skill <name>` | Generated skills and where they're installed · print one |
| | `reflex explain <name>` | Why a skill exists: sessions, repositories, agents, steps |
| **Explore** | `reflex` | The terminal UI: dashboard, tokens, skills, workflows, router, search |
| | `reflex sessions` · `agents` · `stats` | Sessions from the last scan · agents they launched · counts |
| **Measure and improve** | `reflex impact <name>` | Tokens and tool calls per run before vs. after the skill |
| | `reflex validate <name>` | Check a skill; `--run` proves it in a fresh Claude Code session |
| | `reflex improve <skill>` | Compare a skill you already have with the sessions that loaded it and propose an edit |
| **Pick models** | `reflex run "<request>"` | Start Claude Code or Codex on the model the router picks (`--dry-run` shows why) |
| | `reflex route` | Picks per kind of task, autopilot, exploration and bench results |
| | `reflex bench "<task>" --check "<cmd>"` | Run one task on several models, scored by your check command |
| **Memory** | `reflex memory on` · `off` | Tell new sessions the corrections you keep repeating, via `CLAUDE.md` / `AGENTS.md` |
| | `reflex handbook` | How work is done in this repository: commands that worked, ones that failed, repeated corrections |
| **Setup** | `reflex model fetch` | Optional local model for matching requests by meaning (`--light` for 23 MB) |
| | `reflex cursor-usage on` | Record Cursor's token counts through a Cursor hook (not on Windows yet) |
| | `reflex settings matching` | How many sessions make a repeat (2-5) and how strictly they must match |
| | `reflex reset` | Delete Reflex's own data (not installed skills) |

Prompts default to No; without a terminal nothing is read or written unless you pass `--yes`.
Every option: [docs/commands.md](https://github.com/sumervaid/reflex-tui/blob/main/docs/commands.md).

## Supported agents

| Agent | Reads history | Installs skills | Status |
| --- | :---: | :---: | --- |
| Claude Code | ✓ | ✓ | Tested on fixtures matching real files; skill use verified with `validate --run` |
| Codex | ✓ | ✓ | Tested on fixtures; not yet run against real rollouts or a live Codex session |
| Cursor | ✓ | ✓ | Tested on fixtures and real agent transcripts. No command results, so no pass/fail outcome; tokens and cost only while `reflex cursor-usage` is on. `reflex doctor` lists what is missing |
<!-- TEMPLATE: add a row per new agent, e.g. | OpenCode | – | – | Planned | -->

Sessions run through Conductor are read with Claude Code and Codex. Locations and overrides:
[Sources in detail](https://github.com/sumervaid/reflex-tui/blob/main/docs/guide.md#sources-in-detail).

## Privacy

- Transcripts are read locally; scans make no network connections. The only command that uses the
  network is `reflex model fetch`, which you run yourself to download an optional model.
- Secrets, emails, home paths and your user name are redacted before anything is stored or shown.
- Nothing is written outside `~/.reflex` until you install a skill, turn on memory or the Cursor hook,
  or apply a `reflex improve` edit, each after asking. Details: [docs/security.md](https://github.com/sumervaid/reflex-tui/blob/main/docs/security.md)

## FAQ

<details>
<summary><b>Does Reflex send my sessions anywhere?</b></summary>

No. Scans make no network connections, and outgoing sockets are blocked in Reflex's own process.
`reflex model fetch` downloads an optional embedding model when you run it and uploads nothing.
</details>

<details>
<summary><b>Does Reflex itself use my Claude or OpenAI account?</b></summary>

Scanning, suggesting and installing don't. Commands that start an agent do, after asking:
`reflex run`, `reflex bench`, `reflex validate --run` and `reflex improve --verify`.
</details>

<details>
<summary><b>Why didn't it suggest anything?</b></summary>

A workflow needs the same kind of task in at least 3 independent sessions; copies, resumed sessions
and quick retries count once. Try a longer window (`reflex scan --days 30`), or lower the bar with
`reflex settings matching --sessions 2 --strictness looser`. With the optional model
(`reflex model fetch`), requests worded differently can match too.
</details>

<details>
<summary><b>Will it change my CLAUDE.md, AGENTS.md, Cursor hooks or existing skills?</b></summary>

Only if you ask. `reflex memory on` writes a marked block into `~/.claude/CLAUDE.md` and
`~/.codex/AGENTS.md` and leaves the rest of each file as it was; `reflex memory off` removes it.
`reflex cursor-usage on` adds Reflex's hook to `~/.cursor/hooks.json`, keeps your other hooks and
backs the file up first; `off` removes it. Installs never overwrite a file, and `reflex improve` asks
before it changes a skill and keeps a backup.
</details>

<details>
<summary><b>How do I remove everything?</b></summary>

`reflex reset` deletes Reflex's own data and its Cursor hook. Installed skills stay; in `reflex tui`, `space` on an
installed skill removes the copies Reflex wrote, unless you edited them.
</details>

<!-- TEMPLATE: add questions as users ask them (GitHub issues / discussions are a good source). -->

## Roadmap

Known gaps, from the current docs:

- [ ] Run the Codex parser against real rollouts and a live Codex session (it is checked against Codex's source today)
- [ ] Read agents launched from Claude Code sessions (Cursor's are read today)
- [ ] Read Cursor and OpenCode sessions run through Conductor
- [ ] Measure usage limits in the TUI (shows `not measured yet` today)
- [ ] Record Cursor's token counts on Windows (`reflex cursor-usage` is macOS and Linux only)
<!-- TEMPLATE: add planned features here, or link a GitHub project board / milestones. -->

## Docs

- [Commands](https://github.com/sumervaid/reflex-tui/blob/main/docs/commands.md): every command and option
- [Guide](https://github.com/sumervaid/reflex-tui/blob/main/docs/guide.md): how detection works, matching by meaning, improving your skills, measuring a skill, routing tasks to models, prices, sources and limitations
- [Terminal UI](https://github.com/sumervaid/reflex-tui/blob/main/docs/tui.md) · [Security](https://github.com/sumervaid/reflex-tui/blob/main/docs/security.md) · [Architecture](https://github.com/sumervaid/reflex-tui/blob/main/docs/architecture.md) · [Walkthrough](https://github.com/sumervaid/reflex-tui/blob/main/docs/demo.md)
- [Development](https://github.com/sumervaid/reflex-tui/blob/main/docs/development.md): building from source and running the tests

## Status

Reflex is early: version 0.x, and commands and output may change between releases. Confidence scores
are a ranking heuristic, not a probability.

Sponsor integrations (Alike, Darwin) are not included: no public API documentation was available
to build against, and the product works without them.

## Contributing

Issues and pull requests are welcome.

```sh
pnpm install
pnpm build       # bundles the CLI to apps/cli/dist/reflex.js
pnpm test        # vitest across all packages
pnpm typecheck
pnpm lint
```

The monorepo uses pnpm workspaces and Turborepo with strict TypeScript, Zod for untrusted records,
and built-in `node:sqlite` for storage, so there are no native dependencies. The optional embedding
model runs on onnxruntime-web's WebAssembly backend for the same reason. Packages live in
`packages/*`; the CLI in `apps/cli`. `packages/test-fixtures` holds synthetic transcripts used only
by the tests; it is not part of the published CLI. More in [docs/development.md](https://github.com/sumervaid/reflex-tui/blob/main/docs/development.md); internals: [docs/architecture.md](https://github.com/sumervaid/reflex-tui/blob/main/docs/architecture.md).

The README recordings are reproducible on synthetic data: `vhs docs/assets/tui-tour.tape` and
`vhs docs/assets/quickstart.tape`.

<!-- TEMPLATE: CONTRIBUTING.md, once there are contribution guidelines.
See [CONTRIBUTING.md](CONTRIBUTING.md).
-->

<!-- TEMPLATE: community links (Discord, discussions, X/Bluesky), once they exist.
## Community
- [GitHub Discussions](https://github.com/sumervaid/reflex-tui/discussions)
-->

<!-- TEMPLATE: related projects, once you decide which to list.
## Related projects
- [name](url): one line on how it relates to Reflex
-->

<!-- TEMPLATE: contributors and star history, once there are a few of each.
## Contributors
<a href="https://github.com/sumervaid/reflex-tui/graphs/contributors"><img src="https://contrib.rocks/image?repo=sumervaid/reflex-tui" alt="Contributors"></a>

## Star history
<a href="https://star-history.com/#sumervaid/reflex-tui&Date"><img src="https://api.star-history.com/svg?repos=sumervaid/reflex-tui&type=Date" alt="Star history chart"></a>
-->

## License

[MIT](https://github.com/sumervaid/reflex-tui/blob/main/LICENSE) © The Reflex contributors. The npm package also ships
`dist/THIRD_PARTY_NOTICES.md` with the licenses of the libraries bundled into it.
