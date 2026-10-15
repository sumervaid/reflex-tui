<!--
  README TEMPLATE NOTES (delete once filled in)
  Sections marked TEMPLATE are commented out until there is something real to put in them:
  logo, license badge, CI badge, community links, related projects, contributors, star history.
  Image URLs point at the main branch so they also render on npm; they show up after merging.
-->

<div align="center">

<!-- TEMPLATE: logo. Uncomment once docs/assets/logo.svg exists.
<img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/docs/readme-revamp/docs/assets/logo.svg" alt="Reflex logo" width="120">
-->

<h1>Reflex</h1>

<p><b>Reflex finds the workflows you keep re-explaining to Claude Code, Codex and Cursor, and turns them into reusable skills. Runs entirely on your machine.</b></p>

<p>
  <a href="https://www.npmjs.com/package/reflex-skills"><img src="https://img.shields.io/npm/v/reflex-skills?style=flat-square" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/reflex-skills"><img src="https://img.shields.io/npm/dm/reflex-skills?style=flat-square" alt="npm downloads"></a>
  <img src="https://img.shields.io/node/v/reflex-skills?style=flat-square" alt="node version">
  <!-- TEMPLATE: license badge, once a LICENSE file exists
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/reflex-skills?style=flat-square" alt="license"></a>
  -->
  <!-- TEMPLATE: CI badge, once there is a test workflow
  <a href="https://github.com/sumervaid/reflex-tui/actions"><img src="https://img.shields.io/github/actions/workflow/status/sumervaid/reflex-tui/ci.yml?style=flat-square" alt="CI"></a>
  -->
</p>

<p>
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#features">Features</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#supported-agents">Supported agents</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="#docs">Docs</a>
</p>

<img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/docs/readme-revamp/docs/assets/tui-tour.gif" alt="The Reflex terminal UI: dashboard, tokens, skills, workflows, router and search views" width="900">

<sub>Recorded on the synthetic test history in <code>packages/test-fixtures</code>, not real sessions.</sub>

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

<img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/docs/readme-revamp/docs/assets/quickstart.gif" alt="reflex scan, suggest, approve and install on synthetic history" width="800">

If a short window finds nothing, try a longer one. [docs/demo.md](docs/demo.md) walks through the
whole loop on your own history.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/sumervaid/reflex-tui/docs/readme-revamp/docs/assets/how-it-works-dark.svg">
  <img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/docs/readme-revamp/docs/assets/how-it-works-light.svg" alt="Agent history from Claude Code, Codex and Cursor is scanned into redacted traces in ~/.reflex; tasks repeated in at least 3 sessions are detected, reviewed and approved by you, and installed into each agent's skills folder. The terminal UI, router and memory use the same local data." width="900">
</picture>

1. **Scan.** Reflex asks per source, then reads your agents' history locally. Secrets, emails, home
   paths and your user name are redacted before anything is stored.
2. **Detect.** Each session becomes a trace of what was asked and what was done. Traces that match
   across at least 3 independent sessions become a suggestion; one-offs never do.
3. **Review.** Each suggestion shows its evidence: the sessions, the steps and how many sessions had
   each one, and corrections you repeated. You approve or reject it.
4. **Install.** An approved skill is written to `~/.reflex/skills` and copied into the agents you
   choose. Installs never overwrite an existing file.

Details: [How detection works](docs/how-detection-works.md).

## Features

- **Skills from your own repeats.** Only steps seen in at least half the sessions, with example
  commands that recurred and passed a safety filter. No transcript excerpts.
- **A terminal UI.** `reflex` opens seven views over your last scan: Dashboard, Morning, Tokens,
  Skills, Workflows, Router and Search. `space` installs or removes a skill. [docs/tui.md](docs/tui.md)
- **Token and cost view.** Tokens from the last scan and what they would cost at API list prices,
  per day, tool, model and project, and what caching saved.
- **A model router and bench.** `reflex run` starts Claude Code or Codex on the cheapest model that
  needed fixing about as rarely as the most reliable one for that kind of task; `reflex bench` runs
  one task on several models and scores them with your check command.
  [Routing, improve and impact](docs/routing-and-improve.md)
- **Improve skills you already have.** `reflex improve <skill>` compares a skill with the sessions
  that loaded it and proposes an edit, asking before it reads or changes anything.
- **Memory.** Corrections you gave in at least 2 independent sessions, written as a marked block into
  `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` once you run `reflex memory on`.

| Tokens | Skills |
| --- | --- |
| <img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/docs/readme-revamp/docs/assets/tui-tokens.png" alt="Tokens view: cost, cache savings, cost per tool, model and project" width="440"> | <img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/docs/readme-revamp/docs/assets/tui-skills.png" alt="Skills view: suggested skills with the SKILL.md preview" width="440"> |
| **Workflows** | **Router** |
| <img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/docs/readme-revamp/docs/assets/tui-workflows.png" alt="Workflows view: steps and evidence behind a repeated workflow" width="440"> | <img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/docs/readme-revamp/docs/assets/tui-router.png" alt="Router view: cheapest reliable model per kind of task" width="440"> |

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
| **Setup** | `reflex model fetch` | Optional local model for matching requests by meaning (`--light` for 23 MB) |
| | `reflex reset` | Delete Reflex's own data (not installed skills) |

Prompts default to No; without a terminal nothing is read or written unless you pass `--yes`.
Every option: [docs/commands.md](docs/commands.md).

## Supported agents

| Agent | Reads history | Installs skills | Status |
| --- | :---: | :---: | --- |
| Claude Code | ✓ | ✓ | Tested on fixtures matching real files; skill use verified with `validate --run` |
| Codex | ✓ | ✓ | Tested on fixtures; not yet run against real rollouts or a live Codex session |
| Cursor | ✓ | ✓ | Tested on fixtures and real agent transcripts. No tool results or tokens, so no pass/fail outcome or cost |
<!-- TEMPLATE: add a row per new agent, e.g. | OpenCode | – | – | Planned | -->

Sessions run through Conductor are read with Claude Code and Codex. Locations and overrides:
[docs/sources.md](docs/sources.md).

## Privacy

- Transcripts are read locally; scans make no network connections. The only command that uses the
  network is `reflex model fetch`, which you run yourself to download an optional model.
- Secrets, emails, home paths and your user name are redacted before anything is stored or shown.
- Nothing is written outside `~/.reflex` until you install a skill. Details: [docs/security.md](docs/security.md)

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
and quick retries count once. Try a longer window (`reflex scan --days 30`). With the optional model
(`reflex model fetch`), requests worded differently can match too.
</details>

<details>
<summary><b>Will it change my CLAUDE.md, AGENTS.md or existing skills?</b></summary>

Only if you ask. `reflex memory on` writes a marked block into `~/.claude/CLAUDE.md` and
`~/.codex/AGENTS.md` and leaves the rest of each file as it was; `reflex memory off` removes it.
Installs never overwrite a file, and `reflex improve` asks before it changes a skill and keeps a backup.
</details>

<details>
<summary><b>How do I remove everything?</b></summary>

`reflex reset` deletes Reflex's own data. Installed skills stay; in `reflex tui`, `space` on an
installed skill removes the copies Reflex wrote, unless you edited them.
</details>

<!-- TEMPLATE: add questions as users ask them (GitHub issues / discussions are a good source). -->

## Roadmap

Known gaps, from the current docs:

- [ ] Run the Codex parser against real rollouts and a live Codex session
- [ ] Read agents launched from Claude Code sessions (Cursor's are read today)
- [ ] Read Cursor and OpenCode sessions run through Conductor
- [ ] Measure usage limits in the TUI (shows `not measured yet` today)
<!-- TEMPLATE: add planned features here, or link a GitHub project board / milestones. -->

## Docs

- [Commands](docs/commands.md): every command and option
- [How detection works](docs/how-detection-works.md) and its limitations
- [Routing, improve and impact](docs/routing-and-improve.md)
- [Sources and targets](docs/sources.md): history locations, Conductor, environment variables
- [Embedding models](docs/embedding-models.md): optional matching by meaning
- [Terminal UI](docs/tui.md) · [Security](docs/security.md) · [Architecture](docs/architecture.md) · [Walkthrough](docs/demo.md)

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
by the tests; it is not part of the published CLI. Internals: [docs/architecture.md](docs/architecture.md).

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

<!-- TEMPLATE: the repository has no LICENSE file yet. Once it does, replace this line with e.g.
[MIT](LICENSE) © <name> -->
No license file yet.
