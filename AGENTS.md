# Notes for coding agents

## Keep the docs in step with the code

When a change adds or changes something a user can see (a command, an option, a default, what is
read or written, a supported agent), update the docs in the same pull request:

| File | What goes there |
| --- | --- |
| `README.md` | The overview: Features, the grouped Commands table, Supported agents, Privacy, FAQ, Roadmap. One line per command; no option lists |
| `docs/commands.md` | Every command and every option |
| `docs/guide.md` | How things work in detail: detection, matching models, improve, impact, routing, prices, sources, limitations |
| `docs/security.md` | Anything new that Reflex reads, writes, runs or connects to |
| `docs/tui.md` | Changes to the terminal UI |

Internal fixes (performance, locking, refactors, tests) don't go in the README. Tick off or update
items in `docs/readme-backlog.md` when a change settles one.

Rules for `README.md`:

- It is also the npm page (`prepack` copies it into `apps/cli`), so every link and image is a full
  URL: `https://github.com/sumervaid/reflex-tui/blob/main/...` for links and
  `https://raw.githubusercontent.com/sumervaid/reflex-tui/main/...` for images. Relative links
  break on npm. In-page anchors (`#install`) are fine.
- npm only shows a new README after a version is published.
- The recordings in `docs/assets` (`tui-tour.gif`, `quickstart.gif`, `tui-*.png`) are made with VHS
  on synthetic fixtures. After a visible TUI change, run `pnpm build`, then
  `vhs docs/assets/tui-tour.tape` and `vhs docs/assets/quickstart.tape` from the repo root. Never
  record real sessions.
- `how-it-works-light.svg` and `-dark.svg` show the same 4-step flow; edit both together.
- Write short, plain sentences that say what a command does. Check every claim against the code.

## Checks

```sh
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```
