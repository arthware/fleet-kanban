# Playbook injection — a card-layer process prelude for any agent

**Status:** design (plan card — no code)
**Author:** design pass, 2026-07-14
**Card:** `2318a`
**Pairs with:** `4c474` (kill auto-PR / add an explicit "Create PR" action) and `36ab1` (branch at
worktree creation). **Consumes:** the Markdown-card template from `ff6c0`
(`docs/card-authoring.md`). **Feeds on:** `docs/scratch/tasks/fleet-implement.proposal.md` and
`fleet-plan.proposal.md` — these become the first two product-default playbooks.

**Prior art (read with `git show <sha>` before starting):**
- `63e64a4` — *feat: author Kanban cards as Markdown with YAML frontmatter* (branch
  `feat/card-authoring-markdown`, card `ff6c0`). Adds `src/commands/task-card-frontmatter.ts` — the
  frontmatter parser this feature extends with a `playbook:` key, and the `card.prompt` assembly point.
- `724bbdf` — *feat(kanban): per-card agent model so cheaper models can run mechanical cards*. The
  exact per-card-field threading pattern (card schema → start-request → session) that `playbook`
  mirrors end-to-end: `runtimeBoardCardSchema` field → tRPC start request → `runtime-api.ts`
  `startTaskSession`.

---

## 1. Problem & symptom

Every card on the board carries a **task** ("add the widget", "fix the flaky test") but no **process**
— the discipline that says *how* to do the task well: write the BDD surface tests first, then RED
units, then implement, then verify, then open a PR; or, for a design card, investigate → weigh options
→ write the doc. Today that process lives in three incompatible places:

1. **`.claude/commands/fleet-implement.md` / `fleet-plan.md`** (card `3f564`) — slash commands a
   **human** types interactively in Claude Code. They never fire for a card the board launches
   autonomously, and they only exist for one vendor (Claude Code's `/command` mechanism).
2. **The `implement` / `plan` skills** (`.claude/skills`, mirrored) — again Claude-only, and only when
   a human invokes them.
3. **Copy-pasted into the card prompt by hand** — the operator prepends "Run /fleet-implement: …" or
   pastes the whole procedure into each card. This is what actually happens today, and it is the
   symptom: the same 60-line procedure is duplicated across dozens of cards, drifts out of sync, and
   only works if the agent happens to be Claude (a Codex card that reads "Run /fleet-implement" has no
   such command).

So the **process layer is neither reusable, vendor-neutral, nor kept fresh.** A card that runs under
Codex, Gemini, or Cursor gets no procedure at all unless the operator inlined the whole thing, and
even then the inlined copy is frozen at paste time.

**Desired outcome.** A card names a **playbook** — a reusable, named procedure (`fleet-implement`,
`fleet-plan`) — and the board **injects** the current text of that playbook as a prelude to the card
prompt, for **whatever** agent runs the card. One deterministic code path; the playbook auto-updates
with `fleet update`; nothing is copied into the project. The playbook is purely a *process* layer — it
never encodes repo specifics and never suppresses the repo's own conventions (§6).

Naming note: we call it a **playbook**, deliberately **not** a "skill" (that collides with vendor skill
systems — Claude skills, etc.) and **not** a "profile" (that is `implement-profile.md`, the repo's
stack/test/commit specifics, a *different* additive layer — §6).

---

## 2. How a card prompt reaches an agent today (grounded)

The card's prompt is the **only** vehicle that reaches every agent. Tracing it:

- The card record persists its prompt: `runtimeBoardCardSchema.prompt` (`api-contract.ts:180`),
  alongside `agentId`, `agentModel`, `startInPlanMode`, `autoReviewMode` (`:181-190`).
- The client (web-ui `App.tsx:649`, or the `task start` CLI at `task.ts:804`) sends a start request
  carrying `prompt`. All callers converge on **one server handler**: `runtime-api.ts:177`
  `startTaskSession`.
- There, `body.prompt` fans out to the two — and only two — agent runtimes:
  - **Cline SDK path** — `clineTaskSessionService.startTaskSession({ …, prompt: body.prompt })`
    (`runtime-api.ts:263-266`).
  - **PTY path** (claude / codex / gemini / cursor / droid / kiro / opencode) —
    `terminalManager.startTaskSession({ …, prompt: body.prompt })` (`runtime-api.ts:321-328`).

**Key finding: task-card agents have no system-prompt append vehicle.** The vendor-neutral
system-prompt append (`renderAppendSystemPrompt`, `src/prompts/append-system-prompt.ts`) is wired up in
`agent-session-adapters.ts:767` **only for the home/sidebar agent** — `resolveHomeAgentAppendSystemPrompt`
returns `null` unless `isHomeAgentSessionId(taskId)` (`append-system-prompt.ts:339`). So for a *card*,
`--append-system-prompt` (`agent-session-adapters.ts:909`) never fires. The **card prompt is the whole
message.** That is dispositive for the inject-point decision (§5.1).

A distinct handler resends **follow-up chat text** (`runtime-api.ts:747-750`, `prompt: body.text`) — a
user typing a message into a running session. That path must **not** receive the prelude (§5.1); it is
already a separate handler from `startTaskSession`, so scoping the injection to `startTaskSession`
excludes it for free.

---

## 3. Goals & non-goals

**Goals**
- A card names a playbook; the board injects the playbook's **current** text as a prelude for **any**
  agent, via one code path.
- Product-default playbooks ship inside the fleet install and are **read live** — they auto-update with
  `fleet update`; **no files are copied into consumer projects** (this is what avoids staleness).
- One optional, checked-in, vendor-neutral repo override.
- Purely **additive**: the injection never gates or disables the agent's normal loading of
  `CLAUDE.md` / `AGENTS.md` / `implement-profile.md` (§6).

**Non-goals (explicitly out of scope — do not build now)**
- **Vendor-native overrides** (`.claude/commands/<name>.md` taking precedence per harness, a per-agent
  path registry). Vendor-neutral injection already covers Claude too; add later.
- **`fleet init` scaffolding, on-disk generated files, managed/eject provenance markers.** Not needed
  while defaults are read live.
- Any change to how `CLAUDE.md`/`AGENTS.md` are discovered or loaded.

---

## 4. Design overview — two layers, one injection

### 4.1 Resolution (two layers, live read)

Given a playbook **name** (`fleet-implement`), resolve its text at **launch time**:

```
repoOverride   = <project>/.fleet/playbooks/<name>.md      # checked-in, optional, wins
productDefault = <fleet-install>/playbooks/<name>.md        # ships in the install, read live
playbookText   = readIfExists(repoOverride) ?? readIfExists(productDefault) ?? null
```

- **`<project>`** = the card's project workspace path (`workspaceScope.workspacePath` at the injection
  point). This is the same `.fleet` dir the `fleet` CLI walks up to find (`fleet-cli/fleet:35-38`), so
  the override is vendor-neutral, checked in, and co-located with the rest of a project's fleet config.
- **`<fleet-install>`** = the board repo root the running board binary lives in (§4.3). It carries a
  `playbooks/` directory shipped in the fork.

### 4.2 Injection (one code path)

In `runtime-api.ts:177` `startTaskSession`, **after** resolving `body.prompt` and **before** it fans
out to either agent path (`:263`, `:321`), prepend the resolved playbook:

```
finalPrompt = playbookText
  ? `${playbookText.trim()}\n\n---\n\n${body.prompt}`
  : body.prompt
```

Both the Cline and PTY paths then receive `finalPrompt` instead of `body.prompt`. One place, both
runtimes, every agent — deterministic. The `\n\n---\n\n` fence gives the agent a legible seam between
"the process to follow" and "the specific task"; the playbook file itself ends with an explicit
handoff line ("Now read the card below and apply this process to it.").

**Scope:** inject only in `startTaskSession` (the card-prompt launch). The follow-up-chat handler
(`:747`, `body.text`) is untouched, so a user's mid-session message never re-prepends the procedure.
Re-launches (resume / trash-restore) re-send `body.prompt` = the card body, so re-prepending is
correct and desirable — it keeps the process rules in context on every relaunch.

### 4.3 Where product playbooks live & robust path resolution

Product playbooks ship at **`<board-repo-root>/playbooks/<name>.md`**, committed in the fork. The
runtime resolves `<board-repo-root>` from **its own module location**, exactly as `server/assets.ts`
already resolves the bundled `web-ui` (`assets.ts:27-33`: `dirname(fileURLToPath(import.meta.url))`
then walk to the known layout). This is robust across all three ways the board binary is launched
(`fleet-cli/fleet` `kanban_bin`, `:85-99`):

| Launch tier | Board binary | Repo root (= `<fleet-install>`) |
|---|---|---|
| Dogfood source build | `$KANBAN_SOURCE/dist/cli.js` | `$KANBAN_SOURCE` |
| Shared fork build (`fleet update`) | `$KANBAN_SRC_VENDOR/dist/cli.js` | `$KANBAN_SRC_VENDOR` |
| Co-located (`git clone && build`) | `$FLEET_REPO/dist/cli.js` (`fleet:31`) | `$FLEET_REPO` |

In every tier the `playbooks/` dir is a sibling of `dist/` in the same checkout, so a single
module-relative resolve (`resolve(distDir, "../playbooks")`, mirroring `assets.ts`'s
`repoBuildPath`/`packagedBuildPath` cases) finds it. **`fleet update` refreshes that checkout**, so the
product defaults auto-update with no per-project copy — the core requirement.

The one tier without a `playbooks/` dir is the **legacy npm `cline/kanban` vendor build** (`fleet`
tier 4, `:96`) — upstream has no playbooks. That degrades gracefully: resolution returns `null` and the
card runs with no prelude (§5.4). This is acceptable — the fork build (`fleet update`) is what all fleet
projects run; the stable vendor is legacy.

---

## 5. Decisions

### 5.1 Inject point — **prepend to the card prompt** (not append-to-system-prompt)

**Recommend: prepend to the card's initial prompt, server-side in `startTaskSession`.**

| Option | Assessment |
|---|---|
| **A. Prepend to card prompt** (recommend) | Works for **every** agent through the one path both runtimes already share (`runtime-api.ts:263,321`). No per-agent code. Deterministic. |
| **B. Append to system prompt** (`renderAppendSystemPrompt`) | **Does not work for cards at all** — that mechanism is home-agent-only (`append-system-prompt.ts:339`; wired at `agent-session-adapters.ts:767`). Extending it to cards means adding a `--append-system-prompt`-style incantation *per agent* (Claude has the flag; Codex/Gemini/Cursor each differ — see the per-agent divergence in `agent-session-adapters.ts`), i.e. N vendor code paths for what prepend does in one. |

The card body already being "the whole message" for a PTY agent makes A both the simplest and the only
fully vendor-neutral option. Server-side (not client-side) because three+ callers build the start
request (`App.tsx`, `task.ts`, resume paths) — injecting once at their convergence point avoids
duplicating it per caller and keeps it authoritative.

### 5.2 Playbook selection — **explicit `playbook:` field, with `Run /fleet-<x>` inference as back-compat**

**Recommend: both — the explicit field is primary and authoritative; infer from a leading
`Run /fleet-<name>` line only when the field is absent.**

- **Explicit `playbook:` frontmatter field** — add `"playbook"` to `KNOWN_FRONTMATTER_KEYS`
  (`task-card-frontmatter.ts:21-31`), parsed as a non-empty string, mapped onto a new
  `ParsedTaskCard.playbook?: string` and persisted (§7). This is the clean, discoverable primary path
  and extends the `ff6c0` template exactly as `agent`/`model`/`auto-review` already do.
- **Inference fallback** — if no `playbook:` field is set but the body's first non-empty line matches
  `^\s*Run\s+/fleet-(\S+)` (the operator convention today, `docs/scratch/tasks/*.proposal.md` map to
  `/fleet-implement`, `/fleet-plan`), treat `fleet-<captured>` as the playbook name. This keeps the
  **dozens of existing cards** that already say "Run /fleet-implement" working with zero edits, and
  lets a human keep authoring cards the familiar way. The explicit field always wins over inference.

Rejected: **field-only** (breaks every existing card until re-authored — needless churn); **inference-only**
(no clean structured knob; brittle; forces the `/fleet-` string into every card body).

### 5.3 Playbook content & single source of truth

The **product-default playbook markdown is canonical.** `docs/scratch/tasks/fleet-implement.proposal.md`
and `fleet-plan.proposal.md` become `playbooks/fleet-implement.md` and `playbooks/fleet-plan.md`, with
the slash-command chrome stripped (drop the `description:`/`argument-hint:` frontmatter and the
"You are running inside a card worktree" framing that assumes an interactive invocation) and reduced to
the **vendor-neutral process text**: intake → tests-first → implement → verify → commit → PR (for
`fleet-implement`); intake → investigate → design → write-doc → PR (for `fleet-plan`). They must
explicitly hand off to the repo layer ("for stack, test, build, commit rules read the repo's
`AGENTS.md` / `implement-profile.md`") and end with the card handoff line (§4.2).

`.claude/commands/fleet-implement.md` / `fleet-plan.md` **stay** as the manual, interactive-human
`/fleet-*` convenience. Whether they later become *generated from* the canonical playbook (so there is
one true source) is **deferred** — noted in §9, not built now. Until then they are maintained by hand
and simply mirror the playbook's intent.

### 5.4 Unresolved playbook name — **warn + no-op at launch; fail-fast at create when resolvable**

**Recommend: never brick a card. At launch, an unresolved name → warn + run with no prelude. At
create, validate and hard-error when we can, as a fast-feedback nicety.**

- **Launch time (authoritative, soft):** if resolution returns `null` (typo, or a legacy vendor build
  with no `playbooks/`), the card still starts with `body.prompt` unchanged, and the miss is surfaced
  via the **existing** `warningMessage` channel on the start summary (the same non-blocking mechanism
  `runtime-api.ts:211-214` already uses for fleet-tools failures). A card must never be blocked from
  running because a process file moved.
- **Create time (advisory, hard):** `task create --file card.md` can check that the named playbook
  resolves (override or product default present) and hard-error with the list of available names —
  matching how `ff6c0` already hard-errors on unknown frontmatter keys / bad enum values
  (`task-card-frontmatter.ts:60,82`). This is fast feedback, not a guarantee (the file is read live at
  launch and could change between create and start), which is exactly why launch-time stays soft.

---

## 6. CRITICAL: additive, never a replacement

The playbook is **only the process layer.** Injection must be **purely additive** — it must not
suppress or shadow the repo's own conventions. Three layers compose, each owning a different question:

| Layer | Owns | Loaded by | Wins on |
|---|---|---|---|
| **Repo conventions** — `AGENTS.md` / `CLAUDE.md` / `implement-profile.md` | *This repo's* stack, style, test runner, commit rules, verify recipe | The **agent's own** context mechanism (Claude Code auto-loads `CLAUDE.md`; the kanban CLI ref is appended by the harness). **Untouched by this feature.** | **Specifics** — always authoritative over the generic playbook |
| **Playbook** (this feature) | The **generic process** (tests-first → implement → PR; or investigate → design doc). Never encodes repo specifics. | The board, prepended to the card prompt | **Process shape** — but it *explicitly hands off* to the repo layer for every specific |
| **Card body** | *This* task | The card itself | The concrete work |

Two rules make "additive" real:

1. **Injection does not gate loading.** Prepending the playbook to the card prompt changes only the
   card's message; it does nothing to how the agent discovers and loads `CLAUDE.md`/`AGENTS.md`. Those
   still load through the agent's normal mechanism and **win on specifics**. There is no code path in
   this design that reads, edits, or suppresses those files.
2. **The playbook text defers by construction.** Every product-default playbook contains an explicit
   "read the repo's `AGENTS.md` / implement profile for stack, style, test + commit rules" clause
   (already present in both proposals — `fleet-implement.proposal.md:13-14`,
   `fleet-plan.proposal.md:14-15`). The playbook never states a stack fact; when process and repo
   conflict, the repo's specific rule governs.

---

## 7. Implementation outline (phased, hand-off-ready)

**Phase 1 — the two product-default playbooks (no code).**
- Add `playbooks/fleet-implement.md` and `playbooks/fleet-plan.md` (fork repo root), transformed from
  the proposals per §5.3. `.gitignore` unaffected — they ship in the checkout.

**Phase 2 — resolution helper (pure, unit-testable, non-entry).**
- New `src/playbooks/resolve-playbook.ts`:
  - `resolvePlaybookPaths(name, { projectPath, installRoot })` → `{ override, productDefault }`.
  - `resolveInstallRoot()` — module-relative, mirroring `assets.ts:27-33`; return `null` if no
    `playbooks/` sibling (legacy vendor build).
  - `readPlaybookText(name, { projectPath })` → `string | null` (override ?? default ?? null).
  - Keep it a **non-entry** module (no `cli.ts` import) so it is unit-testable — per `AGENTS.md`
    testing rules.

**Phase 3 — frontmatter + inference (`ff6c0` parser).**
- `task-card-frontmatter.ts`: add `"playbook"` to `KNOWN_FRONTMATTER_KEYS`; parse to
  `ParsedTaskCard.playbook?: string`; add `inferPlaybookFromBody(body)` matching a leading
  `Run /fleet-<name>` line; explicit field wins (`:243-251` assembly area).
- `task.ts` create path: thread `playbook` onto the created card; optional create-time validation
  (§5.4) — hard error listing available names.

**Phase 4 — persist the field.**
- `api-contract.ts`: add `playbook: z.string().optional()` to `runtimeBoardCardSchema` (after `:190`,
  optional so an old `board.json` still parses — same discipline as `agentModel`).
- `task-board-mutations.ts`: carry `playbook` through create/update (mirror `startInPlanMode`,
  `:339`/`:679`).
- Add `playbook` to the tRPC start-request schema (`api-validation.ts`) and to the request the clients
  build (`App.tsx`, `task.ts:804`) — mirror `agentModel` threading from `724bbdf`.

**Phase 5 — the injection (one code path).**
- `runtime-api.ts:177` `startTaskSession`: after `body` is parsed and `taskCwd` resolved, compute
  `finalPrompt` (§4.2) from `readPlaybookText(body.playbook, { projectPath: workspaceScope.workspacePath })`;
  pass `finalPrompt` in place of `body.prompt` at **both** `:266` and `:328`. On a `null` resolve with a
  named playbook, attach the miss to `warningMessage` (reuse `applyFleetToolsWarning`-style wrapping,
  `:213`). Leave the follow-up-text handler (`:747`) untouched.

**Phase 6 — docs.**
- `docs/card-authoring.md`: document the `playbook:` field + inference in the field table (`:63-75`).
- `docs/playbooks.md` (new): what a playbook is, the two-layer resolution, how to add a repo override,
  and the three-layer composition (§6).

---

## 8. Test strategy

Following the repo's tests-first discipline (`AGENTS.md`), each layer is exercised at its real seam.

**BDD surface (behavior) tests**
- *Given* a card with `playbook: fleet-implement` and a product default present, *when* the board
  starts the card, *then* the agent's prompt is `<playbook text>\n\n---\n\n<card body>`.
- *Given* a card whose body starts `Run /fleet-plan` and no `playbook:` field, *when* it starts, *then*
  the `fleet-plan` playbook is injected (inference back-compat).
- *Given* both `.fleet/playbooks/fleet-implement.md` in the project **and** a product default, *when*
  the card starts, *then* the repo override text is used (override wins).
- *Given* a card naming an unknown playbook, *when* it starts, *then* the card still launches with an
  unmodified prompt **and** a `warningMessage` names the miss (never blocked).
- *Given* a card with no playbook, *when* it starts, *then* the prompt is the card body verbatim
  (no fence, no prelude) — proves purely additive/no-op default.
- *Given* an injected playbook, *when* the user sends a follow-up chat message, *then* the message is
  **not** re-prefixed with the playbook (scope = launch only).

**Unit (RED) tests**
- `resolvePlaybookPaths` / `readPlaybookText`: override-wins, default-fallback, null-on-miss,
  null-install-root (legacy build).
- `resolveInstallRoot`: correct sibling resolution for the `dist/cli.js` and `dist/server/*.js`
  layouts (mirror `assets.ts` cases).
- Frontmatter: `playbook` parsed; explicit field beats inference; inference regex matches
  `Run /fleet-implement` and ignores non-leading occurrences; unknown-key error still fires for typos.

**Verify**
- Exercise on a **throwaway isolated** board (`npm run kanban:scratch` — never 3500/3200/3484): create a
  card naming a playbook, start it, confirm the launched agent's first prompt contains the prelude;
  confirm a repo override under the scratch project's `.fleet/playbooks/` takes precedence.

---

## 9. Risks, open questions, out-of-scope

**Risks / mitigations**
- *Install-root resolution fragility.* Mitigated by reusing the proven `assets.ts` module-relative
  approach and covering both `dist/` layouts in unit tests; null-safe on the legacy build.
- *Prelude bloats the prompt / dilutes the task.* The `\n\n---\n\n` fence + the playbook's closing
  handoff line keep the seam explicit; playbooks stay short (~1 screen) and generic.
- *Two sources of truth drift* between `playbooks/*.md` and `.claude/commands/fleet-*.md`. Accepted for
  now; the deferred "generate commands from playbook" (below) closes it.

**Open questions**
- Should the injected prelude be visible to the operator in the card's transcript as a distinct block,
  or folded silently into the first message? (Lean: fold in; the fence makes it readable.)
- Fence exact form — `\n\n---\n\n` vs a `# Card` heading. (Lean: `---`; minimal, vendor-neutral.)

**Out of scope (deferred — do not build now)**
- Vendor-native overrides (`.claude/commands/<name>.md` precedence per harness; per-agent path
  registry). Vendor-neutral injection already covers Claude.
- `fleet init` scaffolding, on-disk generated files, managed/eject provenance markers.
- **Generating `.claude/commands/fleet-*.md` from the canonical playbook** — collapses §5.3's two
  sources into one. A clean follow-up once the playbook format has settled.

---

## 10. Relationship to sibling cards

- **`4c474` (kill auto-PR / explicit "Create PR" action).** Both `fleet-implement`/`fleet-plan`
  playbooks already **own their own commit + PR step** rather than relying on the board's auto-review
  PTY injection (which no-ops after the agent exits — see the proposals' own note). This card makes
  those playbooks the *default* prelude; `4c474` removes the competing auto-PR path. They are
  complementary: the playbook drives the PR from inside the session, `4c474` retires the board-side
  auto-PR.
- **`36ab1` (branch at worktree creation).** The playbooks assume a real branch to push (their PR step,
  `fleet-implement.proposal.md:48-55`). `36ab1` guarantees the worktree is on a branch, not a detached
  HEAD, so the playbook's "push + open PR" step stops needing the detached-HEAD fallback dance.
- **`ff6c0` (Markdown card template).** Consumed directly — the `playbook:` field is one more key in the
  same frontmatter envelope (§5.2, §7 Phase 3).
