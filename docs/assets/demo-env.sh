# Source this before recording (the .tape files do it for you). It points HOME, REFLEX_HOME and
# every history and skills folder into a fresh temp dir and fills it with the synthetic
# @reflex/test-fixtures transcripts, so recordings never read or show real sessions, paths or names.
# Needs a built CLI (pnpm build) and is run from the repository root.
#
#   source docs/assets/demo-env.sh

REPO="$PWD"
(cd packages/tui && npx tsup --config tsup.preview.config.ts --silent) || return 1

DEMO_ROOT="$(mktemp -d /tmp/reflex-demo-XXXXXX)"
export HOME="$DEMO_ROOT/home"
export REFLEX_HOME="$HOME/.reflex"
export REFLEX_CLAUDE_DIR="$HOME/history/claude/projects"
export REFLEX_CODEX_DIR="$HOME/history/codex/sessions"
export REFLEX_CURSOR_DIR="$HOME/history/cursor/projects"
export REFLEX_CLAUDE_SKILLS_DIR="$HOME/.claude/skills"
export REFLEX_CODEX_SKILLS_DIR="$HOME/.codex/skills"
export REFLEX_CURSOR_SKILLS_DIR="$HOME/.cursor/skills"
mkdir -p "$REFLEX_HOME" "$REFLEX_CURSOR_DIR" "$REFLEX_CLAUDE_SKILLS_DIR" "$REFLEX_CODEX_SKILLS_DIR" "$REFLEX_CURSOR_SKILLS_DIR"
node "$REPO/packages/tui/dist/write-history.js" "$HOME/history" > /dev/null

export NODE_NO_WARNINGS=1
reflex() { node "$REPO/apps/cli/dist/reflex.js" "$@"; }
cd "$HOME" || return 1
export PS1='$ '
