# @reflex/tui

The Reflex AI terminal UI: seven views (Dashboard, Morning, Tokens, Skills, Workflows, Router,
Search) drawn cell by cell from the Claude Design handoff in `docs/design/tui-v5/`. The shipped
entry point is `reflex tui` in `apps/cli`, which runs this package on the live data source.

## Layout

- `src/types.ts`, `src/model.ts`: the contracts. `TuiData` is everything the views render;
  `DataSource` is where it comes from and how actions (install, autopilot, rescan, resume) reach it.
- `src/render/`: ports of the prototype's layout helpers (`fit`, `box`, `table`, `big`, charts).
- `src/views/`, `src/shell.ts`: the views, sidebar, top bar, status bar and toast.
  `compose(W, H, data, ui)` returns the screen rows plus the click and wheel regions.
- `src/term/`: raw-mode terminal, input parsing (keys, mouse, paste) and the ANSI writer.
- `src/app/state.ts`: the pure reducer, `reduce(ui, event, ctx) -> { ui, effects }`, with the key
  table from the handoff. `src/app/app.ts`: `runTui()`, which draws, ticks the clock, expires toasts
  and runs the effects against the data source.
- `src/live/`: the live data source on Reflex's store.

The UI needs at least 80×24 cells. It never uses the network.

## Preview

```sh
pnpm tui:preview                                  # from the repo root
pnpm --filter @reflex/tui preview -- --clock 08:14:07 --view skills
```

The preview builds `scripts/preview.ts` into `dist/preview.js` (`tsup.preview.config.ts`) and runs
the UI on the design fixture with simulated actions: installs and removals, autopilot, a rescan that
finds 7 new sessions the first time, and resume commands that are shown, not run.
`--clock HH:MM:SS` freezes the top-bar clock; `--view <id>` picks the opening view.

## Tests

```sh
npx vitest run packages/tui
npx tsc -p packages/tui/tsconfig.json
```

The golden tests render the design fixture with the state the mockups were dumped with and compare
every cell (text and style) with `test/golden/reference-{150x45,120x40}.json`, which
`scripts/extract-reference.mjs` produced by running the prototype's own `compose()`.

## The fixture is not shipped

`fixture/` holds the prototype's mock data (`designData()`), the empty and live-shaped data sets used
by the empty-state tests, and `FixtureSource`. It is design mock data for the preview and the tests
only: nothing under `src/` imports it, and it is never bundled into the CLI. The shipped CLI has no
demo mode.
