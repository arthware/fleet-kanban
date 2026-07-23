# Architect doctrine placement — constitution & concept map across a fleet

**Status:** design · **Related:** [`fleet-home-vs-projects.md`](fleet-home-vs-projects.md),
[`architect-console.md`](architect-console.md), [`../architecture/constitution.md`](../architecture/constitution.md),
[`../architecture/concepts/README.md`](../architecture/concepts/README.md)

## Problem

We are giving the architect two new curated artifacts — a **constitution** (the non-negotiable
engineering core) and a **concept map** (the domain ontology that makes "reuse before rebuild"
enforceable, per Constitution Article 1). For a single repo they can just live in
`docs/architecture/`. But fleet is designed to run at a **root that oversees child repos** it does not
necessarily own:

```
fleet-root/            ← the architect (home agent) lives here; holds instance config
  repo1/               ← overseen child project
  repo2/
```

That raises three coupled questions the single-repo answer doesn't:

1. **Placement** — where do the constitution and concept map physically live when the architect
   oversees repos it should not pollute with fleet-specific docs?
2. **Bootstrap** — a brownfield child repo has no concept map, so Article 1 ("consult the concept
   map") is inert until one exists. Who creates it, and when?
3. **Curation** — who keeps the map fresh as work lands, and where does the update go?

The failure mode we are designing against: the architect re-invents near-duplicate concepts across
repos because there is no shared, curated memory of what already exists — the exact cost of fan-out
codegen that Article 1 targets.

## Proposal

**Doctrine is architect-owned and lives at the fleet root, namespaced per repo. Source repos stay
pristine. It reaches cards as primed prompt context, not as files on disk.**

### 1. Two-tier layout — doctrine at the root, source untouched

```
fleet-root/                         (its own git repo — doctrine is versioned HERE)
  .fleet/doctrine/                  (or docs/ — fleet-managed, separated from hand-written docs)
    constitution.md                 harness core (shipped default / instance-wide additions)
    repo1/
      constitution.md               repo1-specific articles (extends the core, never overrides it)
      concepts/                     repo1 concept map (one file per concept + README index)
    repo2/
      { constitution.md, concepts/ }
  repo1/                            ← SOURCE REPO — pristine, no fleet docs committed
  repo2/
```

Three scopes of doctrine, resolved as a precedence chain (most-specific wins; **the harness core is
inviolable — a repo may add articles, never opt out of Articles 1–5**):

| Scope | Content | Home |
| --- | --- | --- |
| **Harness core** | Articles 1–5 (concepts-first, root-cause, test-backed, verification) | **ships with fleet**; overridable/extendable per instance |
| **Fleet instance** | instance-wide additions (e.g. "this fleet is offline-first") | `fleet-root/.fleet/doctrine/constitution.md` |
| **Repo** | repo-specific articles (e.g. fleet-kanban's Art 6–9) + the concept map | `fleet-root/.fleet/doctrine/<repo>/` |

`fleet-kanban`'s own doctrine (`docs/architecture/constitution.md` + `concepts/`) already separates
the shippable core (Art 1–5) from repo-specifics (Art 6–9); at productionization, Art 1–5 extract into
the shipped default and Art 6–9 remain fleet-kanban's repo doctrine.

### 2. Resolution order — in-repo first, root fallback

For a given repo, resolve its concept map (and repo constitution) by checking:

1. **In-repo:** `<repo>/docs/architecture/concepts/` — a repo may *opt in* to owning its map in-tree
   (fleet-kanban does; it doubles as the shipped example and enables atomic same-PR curation).
2. **Root fallback:** `fleet-root/.fleet/doctrine/<repo>/concepts/` — the **default** for any repo that
   should stay clean.

Checking two paths is trivial. The in-repo-first order means adopting the map in a source repo is a
deliberate opt-in, and the non-invasive root location is what happens by default.

### 3. The architect does the research (and may fan out)

When fleet is initialized over a root, for each overseen repo lacking a resolvable concept map the
architect **asks the pilot** (AskUserQuestion — it never silently launches a large analysis):

> *"repo1 has no concept map. Run a research pass to bootstrap its doctrine?"*

On confirmation, **the architect itself researches** — it reads the repo and extracts the concept map
+ a draft repo constitution, writing them to `fleet-root/.fleet/doctrine/<repo>/`. Because the output
lands in the fleet root (which the architect already sits in), there is **no bootstrap card, no
worktree, no PR into the source repo** — strictly less machinery than a card-based bootstrap.

**Scoped sub-agent exception.** The architect *may* spawn sub-agents for this research (parallel
extraction is exactly how it should work — the manual precedent is how fleet-kanban's own map was
built). This is a deliberate carve-out: the "Opus must NOT spawn sub-agents" rule in `AGENTS.md`
targets *implementation and design cards* re-priming and burning tokens; the architect's one-time
research/bootstrap is orchestration, which is its job. State the boundary explicitly wherever the
no-fan-out rule appears: **no fan-out on cards; fan-out is fine for the architect's research.**

The pilot reviews and merges the doctrine into the fleet-root repo. The map is human-curated from the
first commit.

### 4. Cards get a primed slice, not the whole map on disk

Article 1 says "consult the concept map," but cards never need the file. The architect (which has the
resolved map) **selects the concepts a card touches and injects those entries into the card prompt** —
canonical home + do-not-duplicate edge — reusing the existing `## Prior art` priming mechanism. The
card reads its primed slice, extends the canonical home, and reports back. Both the source repo and
the ephemeral worktree stay clean, and the architect stays the gatekeeper for reuse.

### 5. Curation ownership: cards report, the architect curates

Because the root-side map is in a different repo than the code, a card cannot update it "in the same
PR." So:

- **Cards report** concept deltas ("established / moved / removed concept X") as part of finishing.
- **The architect curates** the root-side map after a card lands — reading the merged diff + the
  card's report — as a standing post-merge step.

This is the cleaner ownership model anyway (Article 3: one owner for the ontology; mirrors the
superpowers controller/subagent split). A repo that has opted into the in-repo map instead curates it
atomically in the card's own PR.

**Steady state + drift control:** per-card curation keeps the map current; an occasional **re-converge**
maintenance pass (the architect re-audits the map against the codebase, à la spec-kit `/converge`)
catches drift the incremental updates miss.

## Key decisions & tradeoffs

- **Root-owned doctrine over in-repo (default).** Keeps overseen repos pristine and versions doctrine
  in the fleet instance's own repo. Tradeoff: map and code live in separate repos → curation drift is
  possible. Mitigated by architect-as-curator + re-converge, and by the in-repo-first opt-in for repos
  that want atomic curation.
- **Architect researches directly vs. a bootstrap card.** Chosen because the output goes to the root
  (no worktree/PR into source), so it is strictly less machinery. Tradeoff: the architect takes on a
  heavier one-time task — acceptable because it is gated on pilot confirmation and is exactly the
  orchestration role.
- **Prompt-priming vs. symlinking the map into the worktree.** Priming avoids writing into the source
  repo or the worktree (a symlink would show as untracked in the source repo's git status) and keeps
  the architect the reuse gatekeeper. Tradeoff: the card sees only the primed slice, not the whole map
  — acceptable, and arguably desirable (less context, sharper focus).
- **Harness core is append-only per repo.** Repos extend, never override, Articles 1–5. Preserves the
  meaning of "non-negotiable."

## Risks

- **Curation drift** (root map vs. source code) — primary risk; see mitigations above.
- **Path/namespace collisions** at the root — namespacing under `.fleet/doctrine/<repo>/` (separate
  from the root's own `docs/`) avoids clobbering hand-written docs.
- **Bootstrap cost** on a large brownfield repo — the research pass can be expensive; it is gated on
  pilot confirmation and can be scoped (core concepts first).
- **Stale primed slices** — if the architect primes from a drifted map, a card is misled; re-converge
  + Article 5 (verification) are the backstops.

## Relationship to prior art

- **spec-kit** — mirrors its constitution-as-governed-artifact and `/converge` re-audit; our root-side
  per-repo doctrine is the multi-repo generalization of its single-project `.specify/memory/`.
- **superpowers** — the cards-report / architect-curates split is its controller/subagent model; the
  primed-slice injection is its "hand context as files/primed input, not accumulated history."
- **fleet-kanban today** — the `## Prior art` SHA section is the manual precursor to prompt-priming;
  the in-repo `docs/architecture/concepts/` is the opt-in variant.

## Phase 1b — scoping resolution: one helper for the architect and overseen cards

Phase 1a (commit `6a0bcca`) wired constitution injection but resolved doctrine **without a notion of
scope** — which fleet root owns a repo's doctrine, and how the repo is namespaced under it. That left
two gaps that are really one missing piece:

1. **The architect never saw the constitution** — the card-path injection excluded the home agent, so
   the one agent that *authors cards* and must enforce Articles 1–2 was ungoverned.
2. **Overseen cards resolved in-repo only** — `loadDoctrine` was called with `repoPath` but no
   `fleetRoot`/`repoName`, so it could never reach the root fallback
   (`<fleetRoot>/.fleet/doctrine/<repo>/constitution.md`). A repo that keeps its doctrine root-side
   (the pristine-source default from §1–2) silently got nothing.

Both dissolve once resolution is **scoped**. One helper is the single source of truth for the
architect→repo→`.fleet/doctrine/<repo>` mapping (Article 3); the two paths must not invent the
namespacing separately.

### `resolveDoctrineScope(repoPath, workspaces) → { fleetRoot?, repoName? }`

Wraps `classifyArchitectWorkspace` (the existing containment classifier — no second containment
check):

- **Overseen repo** (an architect exists and `repoPath` is strictly contained by it):
  `{ fleetRoot: <architect repoPath>, repoName: <fleet-root-relative path> }`.
- **Otherwise** (flat/peer board, no architect, or `repoPath` *is* the architect): `{}` — in-repo
  resolution only, i.e. exactly Phase 1a's behavior. Backward compatible.

**`<repo>` namespacing = fleet-root-relative path** (`path.relative(fleetRoot, repoPath)`), not the
basename. Both agree in the flat `fleet-root/repo1` layout the design targets (both yield `repo1`),
but the relative path is **collision-safe** under nesting: `/root/a/kanban` and `/root/b/kanban`
namespace to `a/kanban` vs `b/kanban` instead of clobbering at `kanban/`. It is one `path.relative`
call and mirrors the on-disk containment, so it is the simpler *correct* choice (Article 2/8).

### Which constitution the architect receives, and from where

The architect's home agent roots at the **parent** workspace (`resolveAgentConfigRoot` → e.g.
`tools/`), but a constitution physically lives in a **sub-repo**
(`fleet-kanban/docs/architecture/constitution.md`). The decision:

> **The architect is governed by the constitution of the (harness) repo it oversees — resolved through
> the same `resolveDoctrineScope` + `loadDoctrine` seam as that repo's cards — not by a constitution at
> its own parent root.**

Rationale — the *simplest correct* model that actually closes gap #1 in the live instance:

- The architect must enforce the **harness core** (Articles 1–5). By the constitution's own governance
  clause those articles are **inviolable and identical across every overseen repo** — a repo may add
  articles, never opt out. So *any* overseen repo's constitution carries the core the architect must
  enforce; the architect resolves the first overseen repo that has one (deterministic index order).
- In this instance the architect (`tools/`) oversees exactly one repo, `fleet-kanban`, whose
  `docs/architecture/constitution.md` *is* the instance's constitution (core Art 1–5 + fleet-kanban's
  Art 6–9). Resolving it makes the architect **governed by the same doctrine as the cards it
  dispatches** — the stated goal — and it works today, with no file that must first be planted at the
  bare `tools/` root.
- The alternative — resolve from the architect's own parent root (`tools/docs/architecture/` or
  `tools/.fleet/doctrine/constitution.md`) — is the two-tier model's eventual home for an
  extracted/shipped core, but that file does not exist in this instance, so it would leave the
  architect ungoverned now. When a root-level instance constitution is later introduced it becomes a
  natural higher-precedence source; until then, overseen-repo resolution is what governs the architect.

### Distinct injection mechanisms, one resolution seam

- **Cards** inline the constitution **per launch prompt** (`prependConstitution`) — cards are one-shot.
- **The architect** carries it in its **durable context preamble** (`buildArchitectContextPreamble`,
  its seeded initial-context section) alongside the sub-repo awareness it already gets — it is a
  long-lived session, so the law belongs in seeded context, not prepended to every message.

The two mechanisms stay distinct; both consume the same `resolveDoctrineScope` + `loadDoctrine`
resolution, so there is no double-injection and one namespacing convention.

## Disposition

Hand back to the architect to fan out build cards. Suggested sequence:

1. **Resolution + injection** — implement in-repo-first → root-fallback resolution for the concept map
   and repo constitution; inject the harness core (Art 1–5) into every card and prime touched concepts
   into the card prompt (extends `src/prompts/*-card-directive.ts` + `append-system-prompt.ts`; see the
   [skill-injection](../architecture/concepts/skill-injection.md) concept).
2. **Architect research/bootstrap** — the pilot-gated onboarding pass that writes
   `.fleet/doctrine/<repo>/` for a repo without a map, with the scoped sub-agent exception.
3. **Curation loop** — cards report concept deltas; architect curates post-merge; a re-converge
   maintenance action.
