# Worktree post-create hook

**Card:** c8a59 · **Status:** design for review · **Scope:** small, upstreamable (fork of `cline/kanban`)

## Problem

When Kanban starts a task it creates a per-task git worktree and then makes it usable by
**symlinking every gitignored path** from the base repo into the worktree — `node_modules`
(including nested `web-ui/node_modules`), build caches, etc. — via git's ignore walk. Because of
this, a plain `npm install` inside a fresh worktree is usually redundant: the deps are already there.

Symlinking does **not** cover every project, though. Some setup is fundamentally per-worktree and
cannot be a symlink:

- **Turbopack / Next.js apps.** Their `node_modules` is *deliberately excluded* from symlinking —
  symlinked `node_modules` break Turbopack — by
  `listTurbopackNodeModulesSymlinkSkipPaths` (`src/workspace/task-worktree-turbopack.ts:152`). Those
  worktrees start with **no** `node_modules` and need a real install.
- **Codegen / prepare steps** that write generated sources into the tree: `prisma generate`,
  protobuf/`.proto` compilation, local workspace-package builds (`turbo run build --filter=...`),
  `svelte-kit sync`, etc.
- **Native module rebuilds** (`node-gyp`, `electron-rebuild`) whose artifacts are ABI/path-specific.
- **pnpm store / virtual-store setup** where the `.pnpm` layout must be materialized locally.

There is currently no place for a project to say *"after you make a new worktree, also run this."*
This card designs one: a **user-configurable script Kanban runs once, immediately after it creates a
new task worktree.**

## Why the existing hook system does not fit

`src/commands/hooks.ts` already has "hooks", but they are a different mechanism aimed at a different
lifecycle:

- They are **agent-event** hooks. The CLI (`kanban hooks ingest|notify|codex-hook|gemini-hook`) is
  invoked *by the coding agent's own hook system* (Claude Code / Codex / Gemini `PreToolUse`,
  `Stop`, etc.) and POSTs a normalized event to the runtime over tRPC (`hooks.ingest`).
- The event space is a **fixed, closed enum** — `to_review | to_in_progress | activity`
  (`VALID_EVENTS`, `hooks.ts:29`) — used to drive card column moves and the activity feed. There is
  no "worktree created" event and no natural way to add one: the events map to *agent turns/tools*,
  not to *worktree filesystem lifecycle*.
- They run **inside the agent process**, after the session is already live, and are best-effort
  fire-and-forget (`runHooksNotify` swallows all errors). A worktree setup step must run **before**
  the agent starts and its success/failure must be observable.

So this is a genuinely new mechanism. It shares only the *name* "hook"; to avoid confusion this
design calls it the **worktree post-create hook** (config key `worktree.postCreateCommand`), never
just "hook". The name follows the Dev Containers vocabulary (`postCreateCommand`) so the concept is
recognizable to anyone who has configured a devcontainer — this hook is the direct analogue of
"run once after the workspace is created."

## Where it plugs in

The insertion point already exists and is exactly the run-once boundary we need.

```
ensureTaskWorktreeIfDoesntExist()            src/workspace/task-worktree.ts:442
├─ worktree already exists (HEAD resolves)
│   └─ syncIgnoredPathsIntoWorktree()         :457 / :469   ← re-sync only, NO hook
└─ worktree missing → create under setup lock
    ├─ git worktree add --detach              :522
    ├─ prepareNewTaskWorktree()               :539          ← the ONE run-once boundary
    │   ├─ initializeSubmodulesIfNeeded()
    │   ├─ syncIgnoredPathsIntoWorktree()     (symlink sync)
    │   └─ runWorktreePostCreateHook()        ← NEW, runs LAST
    └─ applyTaskPatch() (restore saved changes)
```

`prepareNewTaskWorktree` (`:404`) is called from **exactly one place** — the creation branch at
`:539`, after `git worktree add`. Existing worktrees are treated as authoritative and only re-synced
(`:457`, `:469`) by calling `syncIgnoredPathsIntoWorktree` **directly**, never
`prepareNewTaskWorktree`. Therefore:

- Placing the hook call at the **end of `prepareNewTaskWorktree`** gives **run-once-on-genuine-creation
  semantics for free** (decision 5). It fires on `git worktree add`, and never on re-sync of an
  existing worktree.
- It runs **after** the symlink sync (decision 3: ordering), so `node_modules` (where symlinked) and
  all other ignored paths are in place before the script runs — an install/codegen step sees the
  fully-prepared tree.

**Do not** put the call in `syncIgnoredPathsIntoWorktree` — that function is on both the create and
the re-sync paths and would re-run the hook on every task start.

## Decisions

### 1. Config location — **per-project** `.cline/kanban/config.json` (recommended)

The setup script is a property of the *repository* ("this project needs `pnpm install`"), not of the
operator's machine. It should travel with the repo and be reviewable in version control. That maps to
the **per-project** config file already resolved by
`getRuntimeProjectConfigPath` → `<repo>/.cline/kanban/config.json`
(`src/config/runtime-config.ts:208`), which today holds `shortcuts`
(`RuntimeProjectConfigFileShape`, `:23`).

Note a deliberate divergence from the prompt-template precedent: `commitPromptTemplate` /
`openPrPromptTemplate` are the existing "user-supplied behavior" fields, but they live in the
**global** file (`RuntimeGlobalConfigFileShape`, `:14`) because a commit/PR workflow is an operator
preference. The post-create hook is the opposite — it is repo-specific — so it belongs next to
`shortcuts` in the **project** file. We follow the prompt templates' *trust model and plumbing shape*
(see §6), not their storage location.

The config is grouped under a `worktree` namespace so future worktree-lifecycle knobs (e.g. the
deferred `symlinkExclude`, see Out of scope) have a natural home:

```jsonc
// <repo>/.cline/kanban/config.json
{
  "shortcuts": [ /* … existing … */ ],
  "worktree": {
    "postCreateCommand": "pnpm install --frozen-lockfile",
    "postCreateTimeoutMs": 300000,     // optional; default 300_000
    "postCreateFailureMode": "warn"    // optional; "warn" (default) | "block"
  }
}
```

`postCreateCommand` accepts a **string** (run through a shell) or a **string array** (spawned
directly, no shell) — see §2. The two extra fields are optional and are the only tuning knobs.

**Global support:** kept out of the MVP but trivially added later — a `worktree.postCreateCommand` on
`RuntimeGlobalConfigFileShape` used as a fallback when the project has none. The plumbing is
symmetric with the prompt templates; we note it as a follow-up rather than build both now.

**Implementation note (do not miss this):** `writeRuntimeProjectConfigFile`
(`runtime-config.ts:384`) currently **deletes** the project config file (and its dir) whenever
`shortcuts` is empty (`:395`). Once the file can also carry a hook, that "delete when empty" logic
must key off *"no shortcuts **and** no hook"*, or a saved hook is silently destroyed the next time
someone clears their shortcuts. This is the single easiest bug to introduce here.

### 2. Hook shape — `string | string[]`, matching the industry convention

`postCreateCommand` accepts either form, following the near-universal **shell-form vs exec-form**
convention (Dev Containers lifecycle commands, Docker `CMD`/`ENTRYPOINT`, Kubernetes
`command`/`args`):

- **String** → run through a **non-interactive** shell, so `&&`, globs, and `$VARS` work:
  - POSIX: `sh -c "<command>"`
  - Windows: `cmd.exe /d /s /c "<command>"` (users who prefer PowerShell write
    `pwsh -NoProfile -Command '…'` as their command).
- **String array** → spawned **directly** (no shell), so there are no quoting/glob surprises:
  `["pnpm", "install", "--frozen-lockfile"]`. Chaining (`a && b`) is shell syntax and therefore only
  works in the string form — multi-step setups use a string or delegate to a script.

We deliberately do **not** add an object/map ("named parallel commands") form — Dev Containers offers
it, but it is overkill for a single setup step. We also do **not** add a separate "script path" field:
every hook system standardized on *"your command can just call a script"*, so a checked-in script is
reached with `bash ./scripts/worktree-setup.sh`. That keeps the config to one concept and leaves the
*interpreter/shebang* choice in the user's hands rather than Kanban guessing it.

The string form mirrors `RuntimeProjectShortcut.command`, which already stores and runs a free-form
command from this same project config — so this introduces no new execution primitive.

**Non-interactive on purpose.** Per this repo's tribal knowledge (`AGENTS.md`: the `zsh -i` /
conda / nvm freeze), the hook must **not** spawn an interactive login shell. Use a bare
`sh -c` / `cmd /c` with the inherited environment. Heavy shell init is the exact hazard we avoid on
this hot path (worktree creation blocks task start).

### 3. Execution contract

| Aspect | Value |
| --- | --- |
| **cwd** | the new worktree path (`worktreePath`) |
| **When** | last step of `prepareNewTaskWorktree`, **after** submodule init + symlink sync |
| **Shell** | non-interactive `sh -c` (POSIX) / `cmd /d /s /c` (Windows) |
| **stdio** | `stdin` ignored; `stdout`+`stderr` captured (combined, ring-buffered) |
| **Environment** | inherited `process.env` **plus** the variables below |

Environment variables exported to the script (namespaced `KANBAN_*` to avoid collisions):

```
KANBAN_TASK_ID          the task id
KANBAN_WORKSPACE_ID     the workspace id
KANBAN_WORKTREE_PATH    absolute path of the new worktree (== cwd)
KANBAN_REPO_PATH        absolute path of the base repo (context.repoPath)
KANBAN_BASE_REF         the resolved base ref for this task
CLINE_HOME              the active CLINE_HOME (so the script can locate board state)
```

`taskId` / `baseRef` are already in scope at the call site; `workspaceId` is not currently threaded
into `ensureTaskWorktreeIfDoesntExist` and must be passed down (small signature addition) so the hook
can receive `KANBAN_WORKSPACE_ID`. `repoPath` is `context.repoPath`; `CLINE_HOME` comes from
`clineHomeDir()`.

### 4. Blocking, timeout, and failure semantics

**Blocking: yes — task start waits for the hook.** `ensureTaskWorktreeIfDoesntExist` is awaited on
the task-start path, so anything `prepareNewTaskWorktree` does already blocks the agent from
starting. This is the *desired* behavior: an agent must not start coding against a half-installed
tree (missing `node_modules`, ungenerated Prisma client). The hook runs synchronously within
creation and the returned worktree-ensure response is withheld until it finishes.

**Timeout:** configurable `postCreateTimeoutMs`, default **300_000 (5 min)**. On timeout, kill the
process group (`SIGTERM`, then `SIGKILL` after a short grace) so a hung `install` can't wedge task
start forever. A timeout is treated as a failure per `postCreateFailureMode`.

**On failure (non-zero exit or timeout) — default `warn`, decouple from teardown:**

- Today, if `prepareNewTaskWorktree` **throws**, the `catch` at `:408` **removes the worktree** and
  rethrows — appropriate for "we couldn't even create/sync the tree." A failed *user* setup step is
  different: the worktree and any restored patch are valid; destroying them loses real state and is
  hostile. So the hook runner must **not** throw out of `prepareNewTaskWorktree` in the default mode.
- **`postCreateFailureMode: "warn"` (default):** log the failure, keep the worktree, and **let the agent
  start**. Surface the failure to the user through the **existing `warning` field** already returned
  by `ensureTaskWorktreeIfDoesntExist` (`:555`, `:535`) — no new response channel needed. The warning
  includes the exit code (or "timed out") and a **truncated tail of combined stdout/stderr** (e.g.
  last ~2 KB) so the operator can see what broke without opening logs.
- **`postCreateFailureMode: "block"` (opt-in):** treat a failed hook as a creation failure — the worktree is
  torn down (reuse the existing `:408` teardown) and the ensure call returns `ok: false` with the
  captured output as the error, so the agent does **not** start. For projects where an install/codegen
  failure means the tree is unusable.

**Surfacing output:** on success, the combined output is written to the runtime server log only (no
UI noise). On failure it goes to the server log **and** the `warning`/error string described above.
We intentionally do **not** stream live output to the UI in the MVP — worktree creation has no live
console surface today, and the ring-buffered tail is enough to diagnose.

### 5. Run-once semantics

Covered by the plug-in point (§"Where it plugs in"): the hook lives inside `prepareNewTaskWorktree`,
which is only reached on genuine `git worktree add` (`:539`). Re-sync of an existing worktree
(`:457`, `:469`) calls `syncIgnoredPathsIntoWorktree` directly and never touches the hook. No extra
"has this run?" bookkeeping is required. **Guardrail for the implementer:** keep the hook call out of
`syncIgnoredPathsIntoWorktree`; if a future refactor moves the symlink sync, the hook must stay bound
to the create-only path.

### 6. Security / trust

The hook runs an **arbitrary command from project config**. This is the **same trust boundary that
already exists** in Kanban:

- `RuntimeProjectShortcut.command` — free-form commands stored in the same
  `.cline/kanban/config.json` and executed when the operator triggers a shortcut.
- `commitPromptTemplate` / `openPrPromptTemplate` — operator-authored text that steers an autonomous
  agent's git actions.

So we introduce **no new trust class**, but the surface is slightly sharper because the post-create
hook runs **automatically on task start**, not on an explicit click. Because `.cline/kanban/config.json`
is checked into the repo, cloning/pulling a repo can *introduce* a hook the operator did not write —
a supply-chain consideration shortcuts don't fully share (a shortcut still needs a click).

Mitigations, kept minimal and upstreamable:

- The configured command is **always shown in the UI** (§7) so it is visible, editable, and
  auditable — never hidden behind an opaque toggle.
- The command is stored and executed **verbatim** (no implicit `sudo`, no privilege change); it runs
  as the same user, with the same environment, as the Kanban runtime — identical to a shortcut.
- Document in `AGENTS.md` that a repo's `.cline/kanban/config.json` can carry an auto-running hook, so
  reviewers treat changes to that file like any other executable project config.
- **Non-goal:** a signing/consent prompt on first run. Called out as a possible future hardening if
  auto-running repo-supplied commands proves too sharp, but out of scope for this card (and heavier
  than the prompt-template precedent warrants).

### 7. UI

A single field in the existing runtime config editor (the same surface that renders the prompt-
template textareas and the shortcuts list). Because the hook is **project-scoped**, place it in the
**project section next to Shortcuts**, not with the global prompt templates.

- A labelled multiline text input — *"Worktree post-create command"* — with helper text: *"Runs once
  in each new task worktree, after Kanban links in node_modules. Use for installs/codegen that
  symlinking can't cover (e.g. Turbopack apps, `prisma generate`)."*
- Optional advanced controls (collapsed): timeout (seconds) and a `warn`/`block` failure-mode toggle.
- Empty field ⇒ no hook (feature is fully opt-in; zero behavior change for existing boards).

## Example: running `pnpm install`

The motivating case, end to end.

**Plain pnpm project** — the whole config is one line:

```jsonc
// <repo>/.cline/kanban/config.json
{
  "worktree": { "postCreateCommand": "pnpm install --frozen-lockfile" }
}
```

On a genuine new-worktree creation, after the symlink sync, Kanban runs
`sh -c "pnpm install --frozen-lockfile"` with **cwd = the new worktree**. `--frozen-lockfile` is the
right default inside a worktree: it's a clean tree tracking the same lockfile, so we want an exact,
reproducible install that fails loudly on a stale lockfile rather than silently rewriting it.

**Turbopack app + codegen** — the case this feature exists for. A Turbopack app's `node_modules` is
deliberately excluded from symlinking (§Problem), so the worktree starts with none; `prisma generate`
then writes generated client code no symlink can provide. Chain with `&&` (string form) and raise the
timeout for a cold install:

```jsonc
{
  "worktree": {
    "postCreateCommand": "pnpm install --frozen-lockfile && pnpm prisma generate",
    "postCreateTimeoutMs": 600000
  }
}
```

**Array form** — a single command with no shell parsing:

```jsonc
{ "worktree": { "postCreateCommand": ["pnpm", "install", "--frozen-lockfile"] } }
```

**Script escape hatch** — anything non-trivial delegates to a checked-in script, which sees the
injected `KANBAN_*` env (§3) on top of the inherited environment:

```jsonc
{ "worktree": { "postCreateCommand": "bash scripts/kanban-worktree-setup.sh" } }
```

```bash
#!/usr/bin/env bash
# scripts/kanban-worktree-setup.sh
set -euo pipefail
echo "Setting up worktree for task $KANBAN_TASK_ID at $KANBAN_WORKTREE_PATH"
pnpm install --frozen-lockfile
pnpm prisma generate
pnpm --filter @app/protos build   # local workspace package the app depends on
```

**Why per-worktree pnpm install is affordable:** with pnpm's content-addressable store, packages
hard-link from a global store (`$PNPM_HOME` / `~/.pnpm-store`), so a per-worktree
`install --frozen-lockfile` **re-links, it doesn't re-download** — fast and disk-cheap. This is a big
part of why running the hook on every creation is reasonable rather than wasteful. (If a project pins
its store *inside* the repo, that path is likely already symlinked in, making the install near-instant.)

**On failure** (default `warn`): the worktree is kept, the agent still starts, and the task-start
response carries a `warning` with the exit code and the last ~2 KB of output — e.g. *"Worktree
post-create command failed (exit 1): `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` …"*. Set
`"postCreateFailureMode": "block"` to instead abort task start and tear the worktree down.

## Files to change (all small)

| File | Change |
| --- | --- |
| `src/config/runtime-config.ts` | Add a `worktree` block (`postCreateCommand: string \| string[]`, `postCreateTimeoutMs?`, `postCreateFailureMode?`) to `RuntimeProjectConfigFileShape`; normalize/read/write it; **fix the "delete project file when shortcuts empty" logic** to also keep the `worktree` block. |
| `src/core/api-contract.ts` | Add the field to `runtimeConfigResponseSchema` and `runtimeConfigSaveRequestSchema` (project-scoped). |
| `src/trpc/runtime-api.ts` / `app-router.ts` | Thread the new field through `buildRuntimeConfigResponse` / save path (mirrors `shortcuts`). |
| `src/workspace/task-worktree.ts` | New `runWorktreePostCreateHook()`; call it at the end of `prepareNewTaskWorktree` (`:404`); thread `taskId`/`workspaceId`/`baseRef` into the create path so the hook env can be built; wrap so a `warn`-mode failure does **not** trigger the `:408` teardown. |
| `web-ui/…` config editor | New project-scoped field + optional advanced controls (Tailwind, dark theme, `Button`/inputs per repo conventions). |
| `AGENTS.md` | One line noting `.cline/kanban/config.json` can carry an auto-running post-create command. |

New helper (e.g. `src/workspace/worktree-post-create-hook.ts`) so the spawn/timeout/output-capture
logic is **unit-testable without booting a worktree**: a pure `buildWorktreeHookEnv(...)` +
`runWorktreePostCreateHook(hook, ctx)` returning `{ ok, exitCode, timedOut, outputTail }`, matching
this repo's rule that CLI/runtime logic must be testable without the entry.

## Test plan

- **Unit (base vitest config, `test/runtime`/`test/utilities` tier):**
  - `buildWorktreeHookEnv` sets `KANBAN_TASK_ID/WORKSPACE_ID/WORKTREE_PATH/REPO_PATH/BASE_REF` and
    `CLINE_HOME`, cwd = worktree.
  - runner: success (exit 0) → `ok`; non-zero exit → `!ok` with captured tail; timeout → killed +
    `timedOut`; output tail is truncated to the cap.
  - `runtime-config` round-trip: hook persists in project config; clearing shortcuts while a hook is
    set does **not** delete the file (the regression this card is most likely to introduce).
- **Integration (isolated instance, `startIsolatedKanbanInstance`):** create a task worktree in a temp
  repo whose `.cline/kanban/config.json` hook writes a sentinel file into cwd → assert the sentinel
  exists in the worktree and **not** in the base repo; re-start the same task (existing worktree) →
  assert the hook did **not** run again (run-once).
- **Failure surfacing:** hook `exit 1` in `warn` mode → worktree still exists, agent starts, ensure
  response carries a `warning` containing the tail; same hook in `block` mode → worktree removed,
  `ok: false`.

## Out of scope / follow-ups

- User-configurable per-path `worktree.symlinkExclude` (a manual extension of the Turbopack
  auto-skip) — the natural companion to this hook: exclude a path from symlinking so it starts empty,
  then let `postCreateCommand` fill it with a real install. Deferred until a non-Turbopack case the
  auto-detection misses actually appears. Explicitly **not** a global on/off toggle — that's the wrong
  granularity (it discards the free `node_modules` repo-wide to solve a per-directory problem).
- Global (operator-level) default hook — plumbing is symmetric; add if requested.
- Per-hook consent/signing prompt on first run from a repo-supplied command.
- Live-streaming hook output to the UI (MVP surfaces a tail on failure only).
- A `postSync` hook that also runs on re-sync of existing worktrees — deliberately excluded; this
  card is create-only by design.
