#!/usr/bin/env bash
# refresh.sh — clean rebuild + daemon restart of the dogfood fleet-kanban board.
#
# Builds THIS fleet-kanban checkout fresh (npm run build), then reloads the
# launchd daemon so the new dist/ goes live. The board runs under launchd
# (com.fleet.kanban.tools, port 3500) so it survives terminal death and
# auto-revives on any kill; `fleet kanban daemon install` re-loads its plist
# pointing at the freshly built dist/cli.js.
#
# WARNING — this restarts the LIVE dogfood board. It briefly kills every session
# on it: the architect and any card you may be running in. The architect session
# is durable (fixed session-id) and resumes on relaunch, but prefer running this
# from a terminal that is NOT itself a card on the board, so you don't cut your
# own branch mid-build.
#
# Usage:
#   scripts/refresh.sh              build + restart (asks to confirm)
#   scripts/refresh.sh -y           skip the confirmation prompt
#   scripts/refresh.sh --no-build   just reload the daemon (skip the build)
set -euo pipefail

# The fleet-kanban checkout (this script lives in <checkout>/scripts). Running
# `fleet` from here lets it walk up to tools/.fleet, so it targets the dogfood
# project (port 3500, CLINE_HOME=tools/.fleet/cline), not the global board.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BUILD=1
ASSUME_YES=0
for a in "$@"; do
	case "$a" in
		--no-build) BUILD=0 ;;
		-y | --yes) ASSUME_YES=1 ;;
		-h | --help) sed -n '2,20p' "$0"; exit 0 ;;
		*) echo "refresh.sh: unknown arg: $a" >&2; exit 2 ;;
	esac
done

command -v fleet >/dev/null 2>&1 || { echo "refresh.sh: 'fleet' not on PATH" >&2; exit 1; }

# Resolve the target board's port from the project's .fleet config (tools/.fleet).
CFG="$ROOT/../.fleet/config.json"
PORT="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('kanban_port',3484))" "$CFG" 2>/dev/null || echo 3484)"
URL="http://127.0.0.1:$PORT"
LOG="$ROOT/../.fleet/kanban.log"

if [ "$ASSUME_YES" != 1 ]; then
	printf '\033[1mThis rebuilds and restarts the LIVE board at %s\033[0m\n' "$URL"
	printf '  → kills current sessions (architect resumes automatically). Continue? [y/N] '
	read -r ans
	case "$ans" in
		y | Y | yes | YES) ;;
		*) echo "aborted."; exit 0 ;;
	esac
fi

if [ "$BUILD" = 1 ]; then
	echo "==> building fleet-kanban (npm run build) …"
	npm run build
else
	echo "==> skipping build (--no-build); reloading current dist/ …"
fi

echo "==> reloading launchd daemon (fleet kanban daemon install) …"
fleet kanban daemon install

echo "==> waiting for the board to answer on $URL …"
for _ in $(seq 1 30); do
	if curl -fsS --max-time 3 "$URL/api/trpc/projects.list" >/dev/null 2>&1; then
		printf '\033[1m✓ board live at %s\033[0m\n' "$URL"
		exit 0
	fi
	sleep 1
done

echo "refresh.sh: board did not answer on $URL within 30s — check: tail -f $LOG" >&2
exit 1
