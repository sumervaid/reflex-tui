# README backlog

Things that would make the README (and the repo's first impression) better, collected during the
README revamp on 2026-10-15. Nothing here is decided; tick or delete items as the team settles them.

## Before merging

- [ ] **Revert the temporary preview commit** (`TEMP: point README images at this branch`) so README
  images point at `main` again. Don't `git revert` it (images added later also use the branch URL); replace `reflex-tui/docs/readme-revamp/docs/assets`
  with `reflex-tui/main/docs/assets` in `README.md`.

## Decisions for the team

- [ ] **License.** The repo has no LICENSE file. Popular repos all have one, and some people and
  companies won't use code without one. MIT is the usual choice for CLIs like this; Apache-2.0 adds
  a patent grant. Once chosen: add `LICENSE`, add `"license"` to `apps/cli/package.json`, and
  uncomment the license badge and the License line in `README.md` (marked `TEMPLATE`).
- [ ] **Logo.** Most popular repos open with one (atuin, opencode, aider, crush, ccusage). An SVG
  works best; a light and a dark version can be swapped with `<picture>` (atuin and opencode do
  this). Put it at `docs/assets/logo.svg` and uncomment the logo block at the top of `README.md`.
- [ ] **The "Sponsor integrations (Alike, Darwin)" line.** It came from the original README
  (commit b06c82d, 2026-10-11). It reads like a note about hackathon sponsor tools that were not
  integrated, not about funding sponsors. It is under "Status" in the README; keep, reword or drop.
- [ ] **GitHub repo description and topics** (both empty today). Set them under the repo's
  About ⚙ on GitHub, or with `gh repo edit sumervaid/reflex-tui --description "..." --add-topic ...`.
  Proposal:
  - Description: "Find the workflows you keep re-explaining to Claude Code, Codex and Cursor, and
    turn them into reusable skills."
  - Topics: `claude-code`, `codex`, `cursor`, `ai-agents`, `agent-skills`, `skill-md`, `cli`, `tui`,
    `developer-tools`, `local-first`
- [ ] **Sponsors / funding section.** Not a priority now. If it ever happens: GitHub Sponsors plus a
  `.github/FUNDING.yml`, and a section like ccusage's.

## Template slots in README.md

Each is an HTML comment marked `TEMPLATE`, invisible on the page until uncommented.

- [ ] Logo (see above)
- [ ] License badge and License line (see above)
- [ ] CI badge: needs a workflow that runs `pnpm test` on pushes and PRs (today the only workflow is
  the embedding benchmark). Then point the badge at that workflow file.
- [ ] `CONTRIBUTING.md`: how to set up, run tests, commit style, what PRs are welcome
- [ ] Community: GitHub Discussions, Discord, X/Bluesky, whichever the team uses
- [ ] Related projects: tools people compare Reflex with, one line each on how it differs
- [ ] Contributors image (contrib.rocks) and star-history chart: turn on once there are a few of each
- [ ] More rows in the Supported agents table as agents are added (e.g. OpenCode)
- [ ] More FAQ entries, from real questions in issues and discussions
- [ ] Roadmap: planned features, or a link to a GitHub project board or milestones

## Ideas from popular repos, not used yet

From atuin, ccusage, lazygit, lazydocker, btop, gum, starship, zoxide, bat, fzf, aider, opencode,
crush and delta.

- Per-feature demos (lazygit, bat): a short GIF or video under each feature instead of one grid
- A docs website (ccusage, aider, starship) once `docs/` grows
- More install methods (Homebrew tap, etc.) as they become available; crush and lazygit list many
- "Mentioned in" / awesome-list badges (ccusage): e.g. submit to awesome-claude-code
- Social badges (Discord member count, follow on X) once those accounts exist
- Testimonials / "Kind words" (aider), once real users say something quotable
- Usage-number badges (aider: installs, tokens per week), only with real numbers
- README translations (opencode has 20+): skipped, the audience is English-only for now

## Problems found while verifying the docs against the CLI

- **TUI wording:** the dashboard says "1 corrections your agents could remember" (plural with 1).
- **TUI branding:** the title bar says "Reflex AI"; everything else says "Reflex".
- **npm description:** the `apps/cli/package.json` description says "Claude Code and Codex" and
  leaves out Cursor.
- **Model size:** `reflex model fetch --help` says bge-m3 is "about 590 MB"; the README, the docs and
  `reflex scan`'s tip say 587 MB.
- **Router task names:** the docs say "debugging, features and tests, edits, research, questions";
  `reflex route explore --protect` accepts `debug, feature, edit, research, explore` ("questions" is
  `explore`). Noted in `docs/routing-and-improve.md`.
- **Undocumented environment variables:** the source reads `REFLEX_CLAUDE_MEMORY_FILE`,
  `REFLEX_CODEX_MEMORY_FILE` and `REFLEX_CURSOR_STATE_DB`, which no doc mentions.
- **Links on npm:** the npm package copies `README.md` at publish time, and relative `docs/...` links
  don't work there. Images already use absolute URLs; links could too
  (`https://github.com/sumervaid/reflex-tui/blob/main/docs/...`).

## CLI ideas noticed while writing the Commands table (code not changed)

Suggestions for the team, not bugs:

- `show <n>` shows a suggestion but `show-skill <name>` shows a skill. Two near-identical names for
  different objects; `reflex skill show <name>` or one `show` that accepts either would be easier to
  guess.
- `approve`, `show`, `evidence` and `reject` take a number or a name; `install`, `explain` and
  `validate` take a name only. Accepting the suggestion number everywhere would let people go
  `suggest` → `install 1` without looking up the name.
- `reflex --help` doesn't list the subcommands of `memory`, `route` and `model`
  (`on`/`off`/`forget`, `autopilot`/`explore`, `fetch`/`use`); you only find them with
  `reflex memory --help`. One line each in the top-level help would make them discoverable.
- `validate --run` only does something for skills named `fix-ci` (or `fix-ci-*`). The help text
  doesn't say so.
- The `stats` help says "defensible counts from local data"; "defensible" is unusual wording for
  users.
- The README's first-time path is scan → suggest (approve) → install. If `suggest`'s approve
  already offers to install (it does when run interactively), the README quick start could drop the
  separate `install` line.

## Recordings

- `docs/assets/tui-tour.gif`, `quickstart.gif` and `tui-*.png` are recorded with VHS
  (`brew install vhs`) on the synthetic fixtures in a temp HOME, never real sessions:
  `vhs docs/assets/tui-tour.tape` and `vhs docs/assets/quickstart.tape` from the repo root after
  `pnpm build`. Re-record after visible TUI changes.
- No background around the recordings (the owner didn't like the purple margin). Possible later: a light-theme version.
- `how-it-works-light.svg` / `-dark.svg` are generated SVGs (a simple 4-step flow; the owner preferred this over a detailed architecture diagram); the README picks one with `<picture>` by
  GitHub theme (npm shows the light one). Edit both when the flow changes.
- The README images point at `main`, so they only show on GitHub after this branch is merged.
