# Cards are typed; a card type is a per-lane skill pipeline

> **Shipped** — see [`docs/card-types.md`](../card-types.md) for the authoritative user and authoring guide.

**Ref / slug:** This card set no external issue ref and dictated the deliverable path explicitly:
`docs/design/card-types-skill-pipeline.md` (ref-less descriptive slug `card-types-skill-pipeline`).
If a Linear/GitHub issue is later attached, rename to `<ISSUE>-card-types-skill-pipeline.md`.

**Status:** implemented (via PRs #127, #128, #129, #131) · **Epic branch:** `epic/card-types` (off
`production-line`) · **Implementation agent:** Gemini.

This doc was the initial spec and build plan for the feature. The architectural direction and every open
decision (D1–D5) are **locked** — see [Locked decisions](#locked-decisions). This doc turns them into
a buildable spec + a file-by-file build plan. It does **not** implement the feature.

---

## 1. Problem & the re-model in one paragraph

Today "plan card" vs "build card" is **hardcoded and implicit**: a card's behavior is derived from two
orthogonal booleans read **once at start** (`startInPlanMode`, `autoReviewEnabled`+`mode`), and the
type→skill binding is three hardcoded TypeScript directive functions that **stack**. Every new
behavior = a new boolean + a new stacking `.ts`. That "recurring pattern = wrong model" smell (our own
`AGENTS.md`) is the tell. The re-model: **a card is a durable, typed unit of work; a card *type* is a
named, data-defined pipeline `phase → lane → skill(s) + directive`, registered like skills already
are.** This *removes* the flag-and-directive-stacking machinery rather than adding to it — three `.ts`
files collapse into one built-in **manifest** + one deterministic generator that derives the injected
directive *from the skill it names* (killing the documented skill/directive drift).

---

## 2. What the code actually does today (verified)

Read directly (no sub-agent sweep). Line numbers are at the SHAs cited in §8.

**Two channels deliver a skill to a card session:**
1. **Native discovery.** Skills live at `<repo>/.agents/skills/<name>/SKILL.md` (and are symlinked into
   each task worktree — `.agents/skills` for codex/gemini/cline, `.claude/skills` for the claude
   agent — by `ensureWorktreeSkillsDirectory`, `src/workspace/task-worktree.ts:135`). The canonical
   source dir is found by `resolveCanonicalSkillsDir` (`task-worktree.ts:116`), which walks
   `resolve(here, ".agents/skills")`, `../`, `../../` from the module dir — so the built `dist/cli.js`
   resolves the repo-tree `.agents/skills` at runtime (skills are **not** copied into `dist`). The
   agent CLI discovers them natively from cwd (spike verdict: `docs/design/55aff-agents-skills-discovery-spike.md`).
2. **The prompt directive** — a *second*, "reliable" channel that names the skill in the prompt text
   (a `SKILL.md` may fail to load; the directive always reaches the agent). `AGENTS.md` explicitly
   warns these two channels **drift**.

**The directive is hardcoded and composed from two booleans — and the composition is *split across two
layers*** (a key finding):

| Flag at start | Directive (hardcoded `.ts`) | Skill | Where it is injected |
|---|---|---|---|
| `startInPlanMode` | `src/prompts/plan-card-directive.ts` | `fleet-plan` | **per-adapter**, at PTY/SDK launch |
| else (default) | `src/prompts/implement-card-directive.ts` | `fleet-implement` | **central**, `runtime-api.ts` |
| `autoReviewEnabled && mode==="pr"` | `src/prompts/pr-card-directive.ts` (**stacks on top**) | `fleet-pr` | **central**, `runtime-api.ts` |
| explicit `body.skill` | (overrides the implement default) | *any named skill* | central |

- **Central path** — `startTaskSession` in `src/trpc/runtime-api.ts` (~L433–463):
  `skillPrompt` → `prependPrCardDirective(…, autoReviewEnabled, mode, baseRef)` →
  `prependImplementCardDirective(…, taskId, startInPlanMode)` (skipped for plan cards, the home agent,
  or an explicit `skill:`) → `prependConstitution(…)`.
- **Adapter path** — `prependPlanCardDirective` is applied **per agent adapter** in
  `src/terminal/agent-session-adapters.ts` (L907, 961, 1047, 1702) and
  `src/cline-sdk/cline-task-session-service.ts:155`, because plan cards are skipped centrally and
  because `planMode` also drives a **real** agent launch flag (`--start-in-plan-mode`), which is
  agent-specific.
- The PR directive is **parameterized** by the card's resolved `baseRef`
  (`buildPrCardPromptDirective(baseRef)` interpolates the base branch).

**Consequences that shape the design:**
- "Type" is implicit and start-time-only. Moving a card between lanes injects **nothing** (only
  link-style auto-start fires). "Skills per phase" does not exist.
- `fleet-smoke` is a skill wired to **no** type — an orphan; proof the binding is ad-hoc.
- The **current lane** of a card is available server-side via `getTaskColumnId(board, taskId)`
  (`src/core/task-board-mutations.ts:394`, columns `backlog | in_progress | review | done | trash`),
  but `startTaskSession` **does not read the board today** — it composes purely from `body` flags.
- Wire/schema fields that must stay additive (Article 7): `runtimeBoardCardSchema` and
  `runtimeTaskSessionStartRequestSchema` (`src/core/api-contract.ts:198, 1213`) carry
  `startInPlanMode`, `autoReviewEnabled`, `autoReviewMode`, `skill`, `baseRef`.
- `gray-matter@^4.0.3` is already a dependency (`package.json:104`) and there is a
  `src/commands/task-card-frontmatter.ts` module — frontmatter parsing is a **reuse**, not a new dep.

---

## <a id="locked-decisions"></a>3. Locked decisions (spec these; do not re-litigate)

| # | Decision | Resolution |
|---|----------|------------|
| **D1** | Phase↔lane granularity | Phases are a **finer, ordered set mapping many-to-one into the 4 real lanes** (backlog / in_progress / review / done). Each phase binds `{lane, skills[], directive-via-skill}`. **Lane entry injects the ordered composition of skills for every *active* phase bound to that lane**, composed in declared order — e.g. `in_progress → [fleet-implement, fleet-pr]`, reproducing today's "pr stacks on implement." |
| **D2** | Single source of truth | The directive is **derived from each skill's `SKILL.md` frontmatter** — one source, composed deterministically. **Delete** `plan-card-directive.ts`, `implement-card-directive.ts`, `pr-card-directive.ts`. The prompt directive still exists (reliable channel) but can no longer drift because it is generated *from* the skill. |
| **D3** | Transition trigger | **Lane entry**, applied at **session (re)start bound to the current lane**. **NO** enter-Review auto-start; **NO** scheduler/DAG — those are the deferred consumer of this model. |
| **D4** | Authoring / registration | Manifests at **`fleet/card-types/<name>.md`** (frontmatter: ordered phases → lane + skills), discovered like `.agents/skills/`. Authored via **first-class `fleet card-type` subcommands** (`new`, `ls`, …) — **not `fleet xtools`**. Type picked per card via **`fleet task create --type <name>`**. |
| **D5** | Migration | A built-in **`feature`** type (shipped **as a manifest**, dogfooding the format) reproduces today **exactly**: `--plan` activates `design`, `--auto-review pr` activates `ship`, a bare card → `build` only → **byte-identical**. Flags become **sugar over the type**. The `verify` (review-lane) phase is **declared but dormant** (fleet-review wired, not fired). **Zero day-one behavior change**; every addition additive and gated on type presence. |

**Out of scope (leave clean seams; do not build):** enter-Review auto-start of a review session; the
autonomous scheduler / DAG orchestration. Seam attach points named in §7.

---

## 4. Data model

### 4.1 What a card *is*

A durable, typed unit of work; compute (the agent session) is ephemeral and swappable. Its shape is
unchanged from today except **one new optional field**:

- **Type** — `cardType?: string` on the card, **defaulting to `feature`** when unset. This is the
  *only* new persisted card state. Everything else (intent, context, binding, lane+history) already
  exists.

Everything about *which* directive a session gets is **derived** at (re)start from `(cardType,
current lane, sugar flags)` — no per-card "active phases" state is persisted. That keeps the change a
single additive optional field (Article 7).

### 4.2 The card-type manifest

A manifest is a Markdown file with YAML frontmatter (parsed with the already-present `gray-matter`),
so it reads like a skill file and can carry prose docs below the frontmatter.

**Path:** `fleet/card-types/<name>.md`. **Discovery** (mirrors `resolveCanonicalSkillsDir`): a
consumer project's own tracked `fleet/card-types/` resolves first; the framework built-ins
(shipped in *this* repo's `fleet/card-types/`, found relative to the module dir like `.agents/skills`)
are the fallback. Project-first / built-in-fallback is exactly the xtools resolution order.

**Frontmatter schema** (new `src/core/card-type.ts`, Zod):

```yaml
name: string                # unique type id; matches the filename stem
description: string         # one line, shown in `fleet card-type ls`
phases:                     # ORDERED list; declaration order is composition order within a lane
  - name: string            # phase id (design | build | ship | verify | …)
    lane: backlog | in_progress | review | done   # the real board lane this phase binds to
    skills: [string, …]     # ordered skill names; each names an .agents/skills/<name>/SKILL.md
    activation: default | plan-flag | auto-review-pr | dormant   # when this phase is active (see 4.3)
    planMode?: boolean      # optional; true → the session launches in REAL agent plan mode
```

Notes:
- `lane` is one of the **four real lanes** (not `trash`). Many phases may bind to one lane (that is
  D1's many-to-one).
- `skills` is ordered; almost always a single skill. Multiple skills in one phase compose in list
  order.
- `activation` is the **data expression of today's two booleans** (see 4.3). It is what makes the
  flags "sugar."
- `planMode` is a per-phase attribute driving the *real* plan-mode launch flag (separate from the
  directive text, which comes from the skill).

### 4.3 Phase activation (how flags become sugar)

A phase's `activation` says when, for a given card, the phase is "active." At (re)start the runtime
computes the active set from the card's existing sugar flags — **no new inputs**:

| `activation` | Phase is active iff | Sugar flag |
|---|---|---|
| `default` | always | (none — the base workflow) |
| `plan-flag` | `card.startInPlanMode === true` | `fleet task create --plan` |
| `auto-review-pr` | `card.autoReviewEnabled === true && card.autoReviewMode === "pr"` | `fleet task create --auto-review pr` |
| `dormant` | **never** (v1) | — (declared for a future consumer; see §7 seams) |

This is a 1:1 restatement of today's start-time booleans as data. A future scheduler adds an
`orchestrated` value here without touching anything else — the clean seam for D3's deferred work.

### 4.4 The built-in `feature` manifest (full — dogfoods the format)

Shipped at `fleet/card-types/feature.md`:

```markdown
---
name: feature
description: The default card workflow — design → build → ship, with a dormant verify lane.
phases:
  - name: design
    lane: backlog
    skills: [fleet-plan]
    activation: plan-flag
    planMode: true
  - name: build
    lane: in_progress
    skills: [fleet-implement]
    activation: default
  - name: ship
    lane: in_progress
    skills: [fleet-pr]
    activation: auto-review-pr
  - name: verify
    lane: review
    skills: [fleet-review]
    activation: dormant
---

# feature

The default workflow every card runs unless it names another type. `design` is activated by
`--plan` and runs the card in real plan mode; `build` always runs; `ship` is activated by
`--auto-review pr` and composes the PR directive **after** build in the same (`in_progress`) lane —
reproducing today's stacking. `verify` is declared so fleet-review has a home the moment the
autonomous loop wants it, but it is dormant in v1 (no auto-start on entering Review).
```

**Resolution walk-through (proves D5 "byte-identical"):**

| Card | Lane at (re)start | Active phases ∩ lane (declared order) | Composed skills → directive |
|---|---|---|---|
| bare card | `in_progress` | `[build]` | `[fleet-implement]` → today's implement directive, verbatim |
| `--plan` card | `backlog` | `[design]` | `[fleet-plan]` → today's plan directive + real plan mode |
| …then moved to | `in_progress` | `[build]` | `[fleet-implement]` |
| `--auto-review pr` card | `in_progress` | `[build, ship]` | `[fleet-implement, fleet-pr]` → implement **then** pr, verbatim |
| any card in | `review` | `[]` (verify is dormant) | no directive injected, no session auto-start |

### 4.5 New types are just new manifests

`bugfix`, `migration`, `spike`, `security-review`, `docs` become new files under `fleet/card-types/`,
each with its own per-phase skills — discovered exactly like `.agents/skills/`. "Discover the need →
add it to the system" = **drop a manifest** (+ its skills if new). No code change.

---

## 5. Directive single-source (D2)

### 5.1 The `SKILL.md` frontmatter field

Add one frontmatter field, `directive`, to each skill that carries a reliable-channel directive. Its
value is the exact text the corresponding deleted `.ts` file produced. A tiny, documented placeholder
vocabulary is interpolated at compose time — **only `${baseRef}` is needed today**.

`.agents/skills/fleet-implement/SKILL.md`:
```yaml
---
name: fleet-implement
description: use when working a build/implementation card — …
directive: >-
  You are working a build card. Use the fleet-implement skill. The card is your authorization to
  commit — commit as you go and never pause to ask for confirmation; the repo's 'never commit unless
  asked' guardrail is written for human sessions and is satisfied by this card.
---
```

`.agents/skills/fleet-pr/SKILL.md` (note the `${baseRef}` placeholder):
```yaml
directive: >-
  You are working an auto-review PR card. Use the fleet-pr skill: the card is your authorization to
  commit and push … open one idempotent PR against this card's base branch `${baseRef}`
  non-interactively — `gh pr create --base ${baseRef} --title <subject> --body <summary>` … and leave
  the card in Review. Never open the PR against the repository's default branch.
```

`.agents/skills/fleet-plan/SKILL.md`:
```yaml
directive: >-
  You are working a plan card. Use the fleet-plan skill: investigate and write a design doc; do not
  implement.
```

`.agents/skills/fleet-review/SKILL.md` — gains a `directive` too (dormant, but wired so the seam is
complete). `fleet-smoke` stays an orphan (no type binds it); leave it a seam, do not wire it in v1.

> The `directive` frontmatter carries the **exact** current strings (whitespace/`\n\n` behavior is
> reproduced by the generator, §5.2). The three `.ts` files are the fixtures — Card B copies their
> literals verbatim; golden-string tests pin byte-identity.

### 5.2 The generator (replaces the three `.ts` files)

New module `src/prompts/compose-card-directive.ts`:

```
composeCardDirective(orderedSkillNames: string[], ctx: { baseRef: string }): string
```

1. For each skill name in order, read its `SKILL.md` frontmatter `directive` (from the canonical
   skills dir — the same source that gets symlinked into worktrees, so the directive **cannot** drift
   from the skill).
2. Interpolate `${baseRef}` (and only the documented placeholders).
3. Concatenate non-empty directives in order, each terminated with `\n\n` (matching today's
   prepend-with-`\n\n` stacking).

Deletion map:

| Deleted | Replaced by |
|---|---|
| `src/prompts/plan-card-directive.ts` | `fleet-plan` `SKILL.md` `directive` + generator; the **real** plan-mode launch flag stays (driven by phase `planMode`, §6) |
| `src/prompts/implement-card-directive.ts` | `fleet-implement` `SKILL.md` `directive` + generator |
| `src/prompts/pr-card-directive.ts` | `fleet-pr` `SKILL.md` `directive` (with `${baseRef}`) + generator |

---

## 6. Injection wiring (D3)

### 6.1 One central composition, replacing the split boolean stack

Rework `startTaskSession` (`src/trpc/runtime-api.ts` ~L433–463) so **all** directive composition
happens once, centrally, type- and lane-driven:

1. Resolve `cardType` (default `feature`); load its manifest via the discovery resolver (§4.2). Home
   agent → no type, skip (unchanged: home agent gets its context preamble, not a card directive).
2. Compute **active phases** from the card's sugar flags via each phase's `activation` (§4.3).
3. Resolve the **current lane** `L = getTaskColumnId(board, body.taskId)`
   (`task-board-mutations.ts:394`). This requires threading the workspace board read into
   `startTaskSession`, which does not read it today (small new coupling — see Open concerns). On a
   `review`/`done`/no-lane result with no active phase bound there, the composed directive is empty
   (no injection), which is correct.
4. Select active phases bound to `L`, in **manifest declaration order**; flatten `skills` → ordered
   skill-name list.
5. `composeCardDirective(orderedSkills, { baseRef: body.baseRef })` → directive string; prepend to the
   prompt (replacing the `withPrDirective`/`withDirectives` stack), then `prependConstitution(…)`
   exactly as today.
6. **planMode:** if any active phase bound to `L` has `planMode: true`, the session launches in real
   plan mode (the value the adapters already receive as `input.startInPlanMode`).

### 6.2 Retire the per-adapter plan directive (the unification)

Because step 5 now composes the plan directive centrally (from `fleet-plan`'s frontmatter for a
`backlog`/plan-lane card), the per-adapter `prependPlanCardDirective` calls become double-injection and
must be **removed**: `src/terminal/agent-session-adapters.ts` (L907, 961, 1047, 1702) and
`src/cline-sdk/cline-task-session-service.ts:155`. The adapters keep only the **real plan-mode launch
flag** they already pass to the agent CLI. This *removes* duplicated per-adapter logic across the
claude/cursor/codex/gemini/cline paths — a genuine simplification, one source.

### 6.3 Explicit `skill:` override — preserved

Today an explicit `body.skill` overrides the implement default. Keep that: an explicit `skill` short-
circuits type composition and composes just that one skill's directive (or none if it has no
`directive` field), preserving today's behavior. Note as a seam that a purpose-built type eventually
supersedes ad-hoc skill overrides.

### 6.4 Flags → phase activation (sugar), end to end

`--plan` → `startInPlanMode:true` → activates `plan-flag` phases (design). `--auto-review pr` →
`autoReviewEnabled && mode==="pr"` → activates `auto-review-pr` phases (ship). No flags → only
`default` phases (build). Identical to today's two-boolean behavior, now expressed as data.

---

## 7. Authoring path (D4)

### 7.1 Discovery

`resolveCardTypeManifest(name, { workspacePath })`:
- **Project layer:** `<workspacePath>/fleet/card-types/<name>.md` (a consumer project's tracked dir).
- **Built-in layer (fallback):** `resolveCanonicalCardTypesDir()` — walks `resolve(here,
  "fleet/card-types")`, `../fleet/card-types`, `../../fleet/card-types` from the module dir, mirroring
  `resolveCanonicalSkillsDir`. The built-in `feature.md` lives in *this* repo's `fleet/card-types/`
  and is found relative to `dist/` at runtime (no build-asset copy needed — same mechanism as skills).

### 7.2 `fleet card-type` subcommands (bash `fleet-cli/fleet`)

A new `fleet_card_type()` family modeled **exactly** on `fleet_xtools()` (`fleet-cli/fleet:1687`), and
a dispatch arm `card-type|card-types|ct) fleet_card_type "$@";;` in the main `case "$cmd"`
(`fleet-cli/fleet:1714`). This is **framework machinery in the CLI proper** — not xtools (D4).

- `fleet card-type ls` — list discovered manifests (name + `description`) across project + built-in
  dirs, dedup by name (mirror `xtools_list`).
- `fleet card-type new <name>` — scaffold `fleet/card-types/<name>.md` from a template (frontmatter
  with an example phase list + prose). Validate name (`_xtools_valid_name`), refuse existing.
- `fleet card-type show <name>` / `path <name>` — print the manifest / its resolved path.
- (`edit` / `rm` parallel to xtools — optional, cheap to include.)

### 7.3 `fleet task create --type <name>`

- Bash: in `fleet_task()` create (`fleet-cli/fleet:963`), add
  `--type) extra+=(--card-type "$2"); shift 2;;`. The existing `--plan` / `--auto-review pr` sugar is
  unchanged and now maps to phase activation of the (default `feature`) type.
- Kanban CLI: add `--card-type <name>` to `task create` in `src/commands/task.ts`, persisting
  `cardType` onto the card. Frontmatter card docs (`--file`/`--markdown`) may also carry `cardType:`.

---

## 8. File-by-file build plan (~4 cards)

**Impl agent: Gemini.** Scope each card tight and primed — exact files + prior-art SHAs named; **no
codebase-discovery sub-agents**. Every card writes **module tests through the public surface** first
(Article 4) and commits at coherent boundaries (Article 9).

**Collision map & sequencing.** Cards **A → B → C** all touch the prompt-composition surface and must
be **sequenced/linked** (C integrates A's manifest resolver with B's generator inside
`runtime-api.ts`). **Card D** is a separate surface (bash CLI + `src/commands/task.ts`) and runs **in
parallel**; its kanban half has a soft dependency on A's `cardType` field (land D's kanban flag after
A) while the bash half is fully independent.

```
A (data model + discovery + feature.md)
      └─▶ B (skill directive frontmatter + generator; delete 3 .ts)
                └─▶ C (central type+lane injection; retire per-adapter plan directive)
D (fleet card-type CLI + --type) ── parallel ── (kanban --card-type flag lands after A)
```

### Card A — Card-type data model, manifest schema, discovery + built-in `feature` manifest

*Pure addition; zero behavior change (nothing consumes it yet).*

- **New** `src/core/card-type.ts` — Zod schema for the manifest (§4.2); `parseCardTypeManifest(raw)`;
  `resolveActiveSkillsForLane(manifest, { startInPlanMode, autoReviewEnabled, autoReviewMode, lane })`
  → ordered skill-name list + a `planMode` boolean (§4.3–4.4).
- **New** `src/prompts/card-type-discovery.ts` — `resolveCanonicalCardTypesDir()` +
  `loadCardTypeManifest(name, { workspacePath })` (§7.1), mirroring `resolveCanonicalSkillsDir`. Reuse
  `gray-matter` for frontmatter.
- **New** `fleet/card-types/feature.md` — the full built-in manifest (§4.4).
- **Additive schema** (Article 7): optional `cardType?: string` on `runtimeBoardCardSchema` and
  `runtimeTaskSessionStartRequestSchema` (`src/core/api-contract.ts:198, 1213`).
- **Module tests:** parse `feature.md`; for each `(lane, flags)` row of the §4.4 table assert the
  exact ordered skill list and `planMode`.
- **Read first:** `src/core/api-contract.ts` (schema idioms), `src/workspace/task-worktree.ts:116–170`
  (`resolveCanonicalSkillsDir`), `docs/design/55aff-agents-skills-discovery-spike.md`.
  **Prior art:** `83aaa59` (worktree skills mount), `f19e28e` (skills-discovery spike doc).

### Card B — Directive single-source: `SKILL.md` frontmatter + generator; delete the three `.ts`

- Add `directive:` frontmatter to `.agents/skills/{fleet-plan,fleet-implement,fleet-pr,fleet-review}/SKILL.md`,
  copying the **exact** current strings (fleet-pr uses `${baseRef}`) (§5.1).
- **New** `src/prompts/compose-card-directive.ts` — `composeCardDirective(orderedSkills, { baseRef })`
  (§5.2), reading directives from the canonical skills dir.
- **Delete** `src/prompts/plan-card-directive.ts`, `implement-card-directive.ts`, `pr-card-directive.ts`.
- **Module tests (golden-string):** `composeCardDirective(["fleet-implement"], …)` === the old
  implement literal; `["fleet-implement","fleet-pr"]` with a `baseRef` === old implement+pr stack;
  `["fleet-plan"]` === old plan literal. Byte-identity is the migration guarantee.
- **Read first:** the three `*-card-directive.ts` files (their literals are the fixtures),
  `docs/design/55aff-agents-skills-discovery-spike.md`. **Prior art:** `aef6d66` (commit-authorization
  sentence), `2c67562` (non-interactive `gh pr create` / base-branch text), `bf84643` (fleet-pr as
  sole done-authority) — the exact directive wording these produced must be preserved.

### Card C — Injection: central type+lane composition; retire the per-adapter plan directive

*The integration card — sequence AFTER A and B.*

- Rewrite `runtime-api.ts` ~L433–463 (§6.1): resolve type → active phases → current lane via
  `getTaskColumnId` (thread the workspace board read into `startTaskSession`) → `composeCardDirective`
  → prepend, then `prependConstitution`. Preserve the explicit `body.skill` override (§6.3) and the
  home-agent skip.
- Remove `prependPlanCardDirective` at `src/terminal/agent-session-adapters.ts` L907, 961, 1047, 1702
  and `src/cline-sdk/cline-task-session-service.ts:155` (§6.2); adapters keep only the real plan-mode
  launch flag.
- **Behavior tests (Given/When/Then through `startTaskSession`):** bare card in `in_progress` → prompt
  begins with the implement directive only; `--plan` card in `backlog` → plan directive + plan mode;
  `--auto-review pr` card in `in_progress` → implement **then** pr directive; explicit `skill:` →
  override; home agent → unchanged.
- **Read first:** `src/trpc/runtime-api.ts:380–463`, `src/terminal/agent-session-adapters.ts` (the four
  call sites), `src/cline-sdk/cline-task-session-service.ts:155`, `src/core/task-board-mutations.ts:394`,
  Card A + Card B outputs. **Prior art:** `045957b` (most recent `runtime-api.ts` composition/epic
  marker change), `aef6d66` (directive composition).

### Card D — Authoring CLI: `fleet card-type` family + `fleet task create --type`

*Separate surface — runs in parallel; kanban half lands after A.*

- Add `fleet_card_type()` (ls/new/show/path[/edit/rm]) to `fleet-cli/fleet`, modeled on
  `fleet_xtools()`; dispatch arm `card-type|card-types|ct)` (§7.2). Add
  `--type) extra+=(--card-type "$2")` to `fleet_task` create (§7.3).
- Add `--card-type <name>` to `task create` in `src/commands/task.ts`, persisting `cardType`; allow
  `cardType:` in card-doc frontmatter.
- **Tests:** fleet-cli test in the `fleet-cli/epic_test.py` style (scaffold/ls a manifest); kanban
  `task.ts` create-flag test asserting `cardType` persists.
- **Read first:** `fleet-cli/fleet` (`fleet_xtools` @1687, `fleet_task` create @963, dispatch @1714),
  `src/commands/task.ts` (create), `fleet-cli/epic_test.py`. **Prior art:** `9d5edb6` (fleet epic
  create/complete — the first-class subcommand pattern), `2361fa6` (promote `land` to a first-class
  `fleet task` subcommand).

---

## 9. Migration / compatibility — zero day-one behavior change

- **Byte-identical directives.** The built-in `feature` manifest reproduces the exact current mapping;
  Card B's golden-string tests pin the composed directive to today's three literals for every
  `(lane, flags)` combo.
- **Default type.** `cardType` defaults to `feature` when unset, so every existing card behaves as a
  `feature` card. The field is optional at the persistence/wire boundary (Article 7); a `board.json`
  written before this field parses unchanged.
- **Sugar flags unchanged on the wire.** `startInPlanMode` / `autoReviewEnabled` / `autoReviewMode`
  keep their shapes and now drive phase **activation**, yielding the same skill set as today.
- **verify dormant.** `fleet-review` is wired (manifest phase + `directive` frontmatter) but
  `activation: dormant` → never injected, no session auto-starts on entering Review (D3).
- **Adapter unification is invisible.** The composed plan directive is the same text as the removed
  per-adapter one, from a single source.
- **No orchestration.** The current lane is read only to *pick* the directive at (re)start — the
  "lane entry injects the skill" substrate, nothing auto-fires.

**Clean seams (out of scope; where they attach):**
- **Enter-Review auto-start** attaches at the board column-move handler (where `moveTaskToColumn` /
  the review notification fire). A future consumer starts a `verify`-phase session on entry to
  `review`; `activation: dormant` flips to `orchestrated`.
- **Scheduler / DAG** attaches at **phase activation** (§4.3): a new `activation: orchestrated` value
  + an external driver that advances phases. The manifest already expresses ordered phases; the
  scheduler consumes them.
- **fleet-smoke** remains an orphan skill — the seam for a future `smoke`/`test` type, not wired now.

---

## 10. Open concerns (not a re-decision — flags for the build agent)

1. **Split-composition removal (highest-risk mechanical step).** The plan directive lives in the *four
   adapters + the cline path*, not the central composer. Card C **must** remove every call site or the
   plan directive double-injects. This is called out explicitly so it is not missed; the
   Given/When/Then plan-card test guards it.
2. **Threading the board into `startTaskSession`.** `runtime-api.ts` does not read the board today;
   lane-driven composition requires `getTaskColumnId(board, taskId)`. This is a small new read on the
   workspace scope (the board is already loadable server-side). If loading the board on the start hot
   path proves costly, the current lane could instead be passed on the start request as an additive
   field — but the board read is the cleaner single-source choice and is preferred unless profiling
   says otherwise.
3. **`directive` YAML multi-line fidelity.** The current literals include `\n\n` separators and inline
   backticks. Card B must reproduce whitespace via the generator's join (`\n\n`), not rely on YAML
   block-scalar trailing-newline behavior — the golden-string tests are the arbiter.
