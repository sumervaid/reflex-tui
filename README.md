# Reflex

Reflex finds the workflows you keep re-explaining to Claude Code, Codex and Cursor, and turns them into reusable skills. Runs entirely on your machine.

[![npm](https://img.shields.io/npm/v/reflex-skills)](https://www.npmjs.com/package/reflex-skills)

A skill is a `SKILL.md` file of reusable instructions; Claude Code, Codex and Cursor pick installed
skills up when a new session starts.

<p align="center">
  <img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/tui-tour.gif" alt="The Reflex terminal UI: dashboard, tokens, skills, workflows, router and search views" width="900">
</p>

<sub>Recorded on the synthetic test history in <code>packages/test-fixtures</code>, not real sessions.</sub>

## Install

Requires Node.js 22.13 or newer.

```sh
npm install -g reflex-skills   # installs the `reflex` command (the npm name `reflex` is a different package)
```

## Quick start

```sh
reflex scan --days 30     # read your Claude Code / Codex / Cursor history (asks first)
reflex suggest            # review suggestions: [a]pprove, [e]vidence, [r]eject
reflex install <name>     # copy an approved skill into Claude Code, Codex and/or Cursor (asks per target)
```

`reflex doctor` shows what Reflex can see without reading anything. Suggestions need the same kind
of task in at least 3 independent sessions; if a short window finds nothing, try a longer one.
[docs/demo.md](docs/demo.md) walks through the whole loop on your own history.

<img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/quickstart.gif" alt="reflex scan, suggest, approve and install on synthetic history" width="800">

## What you get

- **Skills from your own repeats.** A workflow is suggested only after it shows up in at least 3
  independent sessions, with the evidence behind it. [How detection works](docs/how-detection-works.md)
- **A terminal UI.** `reflex` opens seven views over your last scan: sessions, tokens and their cost
  at API list prices, skills to review, workflows, router and search. [docs/tui.md](docs/tui.md)
- **A model router and bench.** `reflex run` starts Claude Code or Codex on the cheapest model that
  needed fixing about as rarely as the most reliable one for that kind of task; `reflex bench` runs
  one task on several models and scores them with your check command.
  [Routing, improve and impact](docs/routing-and-improve.md)
- **Memory.** Corrections you gave in at least 2 independent sessions, written as a marked block into
  `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` once you run `reflex memory on`.

## Screenshots

| Tokens | Skills |
| --- | --- |
| <img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/tui-tokens.png" alt="Tokens view: cost, cache savings, cost per tool, model and project" width="440"> | <img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/tui-skills.png" alt="Skills view: suggested skills with the SKILL.md preview" width="440"> |
| **Workflows** | **Router** |
| <img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/tui-workflows.png" alt="Workflows view: steps and evidence behind a repeated workflow" width="440"> | <img src="https://raw.githubusercontent.com/sumervaid/reflex-tui/main/docs/assets/tui-router.png" alt="Router view: cheapest reliable model per kind of task" width="440"> |

Recordings are reproducible: `vhs docs/assets/tui-tour.tape` and `vhs docs/assets/quickstart.tape`.

## Privacy

- Transcripts are read locally; scans make no network connections. The only command that uses the
  network is `reflex model fetch`, which you run yourself to download an optional model.
- Secrets, emails, home paths and your user name are redacted before anything is stored or shown.
- Nothing is written outside `~/.reflex` until you install a skill. Details: [docs/security.md](docs/security.md)

## Docs

- [Commands](docs/commands.md): every command and option
- [How detection works](docs/how-detection-works.md)
- [Routing, improve and impact](docs/routing-and-improve.md)
- [Sources and targets](docs/sources.md): history locations, Conductor, environment variables
- [Embedding models](docs/embedding-models.md): optional matching by meaning
- [Terminal UI](docs/tui.md) · [Security](docs/security.md) · [Architecture](docs/architecture.md)

## Status and limitations

- Codex: the parser follows the Codex protocol types and is tested on fixtures; it has not yet been
  run against real rollouts or a live Codex session.
- Cursor doesn't record tool results or tokens, so its sessions have no pass/fail outcome or cost and
  aren't routed.
- Confidence is a ranking heuristic, not a probability. Without the optional model, requests worded
  with no words in common don't match. More in [how detection works](docs/how-detection-works.md#limitations).
- Sponsor integrations (Alike, Darwin) are not included: no public API documentation was available
  to build against, and the product works without them.

## Contributing

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

## License

<!-- LICENSE PLACEHOLDER: the repository has no LICENSE file yet. -->
No license file yet.
