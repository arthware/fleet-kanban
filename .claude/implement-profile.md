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
- **Read the card's `## Prior art` commits first (if any).** When the card cites prior-art SHAs, run
  `git show <sha>` (and `git log -p -1 <sha>`) on each before writing code and follow the established
  pattern — this is the primed-context path that replaces a broad codebase sweep (see `AGENTS.md` →
  "Don't research from zero" / "Prior-art commits").

## Tests

- Runner: **vitest**. Server tests under `test/`; web-ui tests colocated as `*.test.tsx`.
- **BDD surface layer** = render a component/hook (`react-dom` + `act`, see
  `web-ui/src/hooks/use-workspace-sync.test.tsx`) or call a tRPC procedure, and assert its contract.
  **Unit layer** = pure functions, reducers, helpers, path/serialization logic.
- The **real, test-inclusive typecheck is `npm run typecheck`** (`tsc -p tsconfig.json`, which
  includes `test/**`) — this is what the pre-commit hook runs. `npm run build` only *bundles*
  (vite + esbuild via `scripts/build.mjs`); it runs **no `tsc`**, so a green build does **not** mean
  the tests typecheck. Run `npm run typecheck` to confirm test files compile.

### Pragmatic testing (exploration phase)

We're still exploring, so be pragmatic: **if a test is too dangerous or too complicated to run
safely, don't — skip it, say so, and lean on the targeted units + `npm run typecheck`.** Chase
coverage of the logic you changed, not the whole suite.

- Prefer the **targeted unit tests for the code you touched** (`vitest run <path>`) for a fast loop.
- **The old "a test run deletes your worktree" hazard is fixed.** Every server test now boots
  through `test/setup/isolated-home.ts` (wired in `vitest.config.ts`), which strips any inherited
  `CLINE_HOME` and points `HOME` at a throwaway dir — so `clineHomeDir()` can never resolve to the
  dogfood board home whose `worktrees/` holds your worktree. The fast suite, the integration suite,
  and the pre-commit hook are all safe to run in the dogfood worktree now, so **let the hook run —
  don't `--no-verify`.** (This bit us once, before the isolation existed.)

## Build / lint

- Build: `cd fleet-kanban && npm run build` — bundles (vite + esbuild via `scripts/build.mjs`). It
  does **not** typecheck; use `npm run typecheck` for the type gate.
- Lint / format: **biome** — `./node_modules/.bin/biome check --write`. The husky pre-commit hook
  runs biome + `npm run typecheck` + the fast test suite; keep all three green and let the hook run
  (it's safe here — see the home-isolation note above).

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
