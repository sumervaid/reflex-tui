# Contributing to Reflex

Thanks for helping. Please also read our [code of conduct](CODE_OF_CONDUCT.md).

## Setup

You need Node.js 22.13+ and pnpm.

```sh
pnpm install && pnpm build && pnpm test
```

More in [docs/development.md](docs/development.md); internals are in
[docs/architecture.md](docs/architecture.md).

## Before you open a pull request

Run what CI runs:

```sh
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

## Conventions

- One change per pull request, linked to its issue.
- One-line commit messages.
- Tests for behavior changes.
- Docs updated in the same pull request when a user can see the change. [AGENTS.md](AGENTS.md) says
  which file covers what.

## Privacy rules

Reflex reads people's agent transcripts, so these apply to every change (details in
[docs/security.md](docs/security.md)):

- No network calls outside `reflex model fetch`.
- No transcript text in skills or fixtures. Fixtures are synthetic.
- Redact before anything is stored or shown.

## Reporting a security problem

Please don't open a public issue. Use the [private reporting form](https://github.com/sumervaid/reflex-tui/security/advisories/new) instead.
