#!/usr/bin/env bash
# fleet-cli installer — symlink the fleet CLI onto your PATH.
#
#   ./fleet-cli/install.sh [BIN_DIR]     # BIN_DIR defaults to ~/.local/bin
#
# Idempotent: re-running just refreshes the symlinks. It does NOT build the board
# (that happens per-project via `fleet kanban install --source <this-checkout>`).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="${1:-$HOME/.local/bin}"
mkdir -p "$BIN"

for tool in fleet wt port-for; do
  ln -sf "$DIR/$tool" "$BIN/$tool"
  echo "  linked $BIN/$tool → $DIR/$tool"
done

command -v node >/dev/null 2>&1 || echo "! node not found — install Node 18+ to build and run the board"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "! $BIN is not on your PATH — add it (e.g. in ~/.zshrc):  export PATH=\"$BIN:\$PATH\"" ;;
esac

echo "✓ fleet CLI installed. Next: run 'fleet init --port <N>' in your project directory."
