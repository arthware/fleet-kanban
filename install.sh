#!/usr/bin/env bash
# Install the fleet CLI + board WITHOUT keeping a repo checkout in your workspace.
#
# Fetches fleet-kanban into ~/.config/fleet/src (the same checkout `fleet update` keeps
# fresh and the shared-build tier already runs), builds the board binary, and links the
# CLI onto your PATH. Run this instead of cloning and babysitting the repo by hand.
#
#   # public repo:
#   curl -fsSL https://raw.githubusercontent.com/arthware/fleet-kanban/main/install.sh | bash
#   # private repo (uses your git credentials), or from a saved copy of this script:
#   FLEET_REPO_URL=git@github.com:arthware/fleet-kanban.git bash install.sh
#
# Env:   FLEET_REPO_URL (default https://github.com/arthware/fleet-kanban)
#        FLEET_REF       (default main)
#        FLEET_SRC_DIR   (default ~/.config/fleet/src)
#        FLEET_BIN_DIR   (default ~/.local/bin)
# Flags: --no-build      link the CLI only; skip the board build (build later with `fleet update`)
set -euo pipefail

REPO_URL="${FLEET_REPO_URL:-https://github.com/arthware/fleet-kanban}"
REF="${FLEET_REF:-main}"
SRC="${FLEET_SRC_DIR:-$HOME/.config/fleet/src}"
BIN="${FLEET_BIN_DIR:-$HOME/.local/bin}"

build=1
for a in "$@"; do case "$a" in
  --no-build) build=0 ;;
  -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  *) echo "install.sh: unknown arg '$a'" >&2; exit 1 ;;
esac; done

command -v git >/dev/null 2>&1 || { echo "error: git is required" >&2; exit 1; }
if [ "$build" = 1 ] && ! command -v node >/dev/null 2>&1; then
  echo "error: Node 18+ is required to build the board (or re-run with --no-build)" >&2; exit 1
fi

echo "→ fetching fleet-kanban ($REF) → $SRC"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --depth 1 origin "$REF"
  git -C "$SRC" reset --hard "origin/$REF"
else
  mkdir -p "$(dirname "$SRC")"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$SRC"
fi

if [ "$build" = 1 ]; then
  echo "→ building the board binary (this takes a minute)"
  ( cd "$SRC" && npm run install:all && npm run build )
else
  echo "→ skipping board build (--no-build); run 'fleet update' when you want it"
fi

echo "→ linking the CLI onto your PATH"
bash "$SRC/fleet-cli/install.sh" "$BIN"
