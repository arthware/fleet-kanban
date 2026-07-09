# /implement profile — fleet-kanban

Concrete details for the generic `/implement` skill when the work item is in **fleet-kanban** (the
TypeScript / React fork). The workflow, gates, and test philosophy live in `/implement`; this file
only fills in the stack specifics.

**Scope.** Use `/implement` for `fleet-kanban` (TS / React) work. The **`fleet` CLI is
exploration-mode — no unit tests there**; don't run this flow for CLI-only changes.

## Intake

- Issues come from Linear through fleet's API layer (`.fleet/linear.key`) — **not** Linear MCP. The
  card on the board (`http://127.0.0.1:3500`) is the implementation card; read any prior design note
  (`docs/design/<id>.md`) if a design phase produced one.
- Kanban runs each task in its own worktree + branch — if you're already in one, use it.

## Tests

- Runner: **vitest**. Server tests under `test/`; web-ui tests colocated as `*.test.tsx`.
- **BDD surface layer** = render a component/hook (`react-dom` + `act`, see
  `web-ui/src/hooks/use-workspace-sync.test.tsx`) or call a tRPC procedure, and assert its contract.
  **Unit layer** = pure functions, reducers, helpers, path/serialization logic.
- `npm run build` typechecks test files too — keep them compiling.

### Pragmatic testing (exploration phase) — and one hard safety rule

We're still exploring, so be pragmatic: **if a test is too dangerous or too complicated to run
safely, don't — skip it, say so, and lean on the targeted units + `npm run build`.** Chase coverage
of the logic you changed, not the whole suite.

- Run only the **targeted unit tests for the code you touched** (`vitest run <path>`), and **isolate
  `CLINE_HOME` *and* `HOME`** in the test's setup (`clineHomeDir()` prefers `CLINE_HOME` over `HOME`,
  so overriding only `HOME` is not enough).
- **NEVER run the full or integration suite in this dogfood setup.** Those tests manage
  `$CLINE_HOME/worktrees`, and because your task worktree lives *under* `CLINE_HOME`, a full run
  **deletes your own worktree** (wipes tracked files, `node_modules`, and the `.git` pointer). This
  already destroyed a worktree once. Targeted units + build are enough for confidence here.

## Build / lint

- Build: `cd fleet-kanban && npm run build` — runs `tsc --noEmit` (typechecks tests), vite, esbuild.
- Lint / format: **biome** — `./node_modules/.bin/biome check --write`. The husky pre-commit hook
  runs biome + typecheck + the fast test suite, so keep all three green.

## House rules

See `fleet-kanban/AGENTS.md`: no `any`, top-level imports only, dark-theme Tailwind tokens
(`bg-surface-*`, `text-text-*`, `border-*`), prefer `react-use` hooks (via
`@/kanban/utils/react-use`), small single-responsibility files, and SDK-provided types over local
redefinitions.

## Browser-verify (UI / behavior changes)

Verify in an **isolated board, never the product board**:

- Build the fork, then boot on **port 3500 with `CLINE_HOME=~/code/repos/tools/.fleet/cline`** and
  `--skip-shutdown-cleanup`. Prefer `fleet kanban start` — it wires the port, `CLINE_HOME`, and the
  source build for you.
- Exercise the real flow via Claude-in-Chrome (use `http://127.0.0.1:3500`, not `localhost`); check
  the console for errors; capture a snapshot.
- **Never verify on 3484** — that's the product board.
- Kill the test instance afterward — child `claude` procs first, then the server; confirm the port
  is free.

## Commit

**Semantic-commit type prefix** (`feat:` / `fix:` / `docs:` / `refactor:` / `chore:` / `test:` …) +
an end-user subject; **no `Co-Authored-By` trailer** (see `AGENTS.md`). Reference the id. Never
commit unless asked — invoking `/implement` is that ask, but still honor the Commit gate.
