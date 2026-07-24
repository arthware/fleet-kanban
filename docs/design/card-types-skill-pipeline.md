<!-- Seed context handed to the card-types Epic Owner by the Senior Architect.
     This is the pre-design note; your job is to turn it into a full design + decomposition. -->

# Architecture note — cards are typed; a type is a per-lane skill pipeline

*Architect note / pre-design. Captures the re-model of what a card **is** and how card types bind
skills per phase. Feeds a future Opus design card; not itself a spec.*

## The idea

Today "plan card" vs "build card" is **hardcoded and implicit**. The architect should be able to
define **card types** as *data* — each type is a pipeline of `phase → lane → skill(s)` — and, when a
new need is discovered, register a new type + its skills into the system the same way skills already
load. This note defines what a card is and what's associated with it (the skills per phase).

## Honest current model (what the code actually does)

There is **no card-type concept**. "Type" is implicit, derived from two orthogonal booleans at
**start time**, and the type→skill binding is **hardcoded in TypeScript directive functions**:

| Flag at start | Directive prepended (TS) | Skill named |
|---|---|---|
| `startInPlanMode` | `src/prompts/plan-card-directive.ts` | `fleet-plan` |
| else (default) | `src/prompts/implement-card-directive.ts` | `fleet-implement` |
| `autoReviewEnabled && mode==="pr"` | `src/prompts/pr-card-directive.ts` (**composes** on top) | `fleet-pr` |
| explicit `body.skill` | (overrides implement default) | *any named skill* |

Composition happens in `src/trpc/runtime-api.ts` (~L423–434): `prependPrCardDirective` wraps the
prompt, then `prependImplementCardDirective` (unless an explicit `skill:` was passed). Skills live in
`.agents/skills/<name>/SKILL.md`, are delivered into each worktree, and are discovered natively by the
agent CLI. The directive is a **second channel** that *names* the skill in the prompt — the "reliable
channel," because a skill file may not load.

### Four observations that drive the re-model
1. **plan / implement / pr aren't three types — they're phases of one workflow** (design → build →
   ship). That `fleet-pr` *stacks* orthogonally rather than being mutually exclusive is the tell: it's
   a **phase behavior**. This is exactly the "each lane has work → a skill" intuition, half-built.
2. It's **skill-per-*start*, not skill-per-*phase***. The skill is chosen once, at launch, from flags.
   Moving a card between lanes injects nothing (only link auto-start fires). "Skills per phase" does
   not exist yet — it's the thing to build.
3. `fleet-smoke` exists as a skill but is **wired to no type** — an orphan; proof the current binding
   is ad-hoc.
4. Every new behavior today = **a new boolean flag + a new directive `.ts` that stacks**. That's the
   "recurring pattern = wrong model" smell straight from our own `AGENTS.md`.

## The definition to commit to

### What a card **is**
A **durable, typed unit of work**. Compute (the agent session) is ephemeral and swappable; the card is
the state. Its shape:
- **Intent** — the human prompt **+ acceptance criteria** (the machine-checkable contract; see the
  ADE strategy note, Tier 1)
- **Type** — names a card-type definition (below)
- **Context** — base-ref, prior-art SHAs, code-references, links/deps, external-issue
- **Binding** — agent + model (ephemeral compute, decoupled from the card)
- **State** — current lane + history

### What a card **type** is
A named, registered definition — **a pipeline of `phase → lane → skill(s) + directive`, expressed as
data, not code**:

```yaml
type: feature            # today's default, expressed as data
phases:
  design:  { lane: backlog(plan), skills: [fleet-plan] }
  build:   { lane: in_progress,   skills: [fleet-implement] }
  ship:    { lane: in_progress,   skills: [fleet-pr] }        # composes, as it already does
  verify:  { lane: review,        skills: [fleet-review] }    # <-- the lane missing today
```

The type **is** the workflow. The current two booleans collapse into `type=feature` + which phases are
active. New types become new manifests — `bugfix`, `migration`, `spike`, `security-review`, `docs` —
each with its own per-phase skills. "Discover the need → add it to the system" becomes **drop a
card-type manifest + its skills**, discoverable exactly like `.agents/skills/` already are.

### Why this is the right re-model (the good kind — it *removes* machinery)
- Deletes the flag-and-directive-stacking pattern (three `.ts` files that stack).
- Formalizes composition — phases *list* skills explicitly instead of TS stacking them.
- Makes **lane entry the trigger for skill injection** — the substrate the autonomous loop needs
  (enter Review → the review skill actually runs). This gives the Tier-1 verification-depth gap a home.
- Sits on infra that already exists (`.agents/skills/` discovery); the type system is a thin manifest
  binding lanes → skills on top.

## Design decisions the eventual doc must resolve
1. **Phase ↔ lane granularity** — are phases exactly the 4 columns, or a finer ordered set that *maps
   into* lanes? (Lean: type declares ordered phases, each activates in a lane.)
2. **One source of truth for skill + directive.** Today there are *two* channels — the `SKILL.md`
   (native discovery) and the prompt directive (the reliable channel) — and `AGENTS.md` already warns
   they **drift**. The type system should **derive the directive from the skill's frontmatter** so
   there's one source. A real simplification, not just plumbing.
3. **Who triggers a phase transition** — manual column move / link-style auto / an orchestrator?
   Minimum viable: entering a lane injects that lane's skill. (The full auto-scheduler is a *separate*
   concern — scope it out of v1.)
4. **Registration / authoring path** — a manifest (`fleet/card-types/<name>.md` with frontmatter
   linking skills), discoverable + maybe a `fleet xtools` scaffold, mirroring how skills already load.
5. **Migration** — plan/implement/pr become the built-in `feature` type; `--start-in-plan-mode` /
   `--auto-review` become sugar over it. No behavior change on day one.

## Relation to upstream (`cline/kanban#76`)
PR #76 is a **prompts library** — a togglable UI panel that lets users browse/insert community prompts
(`prompts-library-view.tsx` + a `PromptsService` over tRPC). It's *prompt-as-content-to-insert*, the
shallow end of prompt reuse; it has no card-type / phase / skill modeling. Per our fork-tailor rule we
should **not mirror it**. A prompt-library entry could later *feed* a card-type's directive, but the
typed-card-with-per-phase-skills workflow engine is ours and is the differentiator.

## Recommendation
This is a genuine architectural re-model that *removes* code — the kind our guide prefers over stacking
the next flag. Materialize it as an **Opus design card** → `docs/design/`, scoped to **the card +
card-type data model, the skill/directive single-source collapse, and the authoring path**, and
explicitly scoping **out** auto-transition/orchestration (that's the scheduler, a later card that
consumes this model).
