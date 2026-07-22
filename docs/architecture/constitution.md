<!--
SYNC IMPACT REPORT
==================
Version change: (unratified draft) → 1.0.0
Bump rationale: Initial ratification. Distilled from AGENTS.md + docs/architecture.md into a short,
  gate-checkable core. MAJOR baseline: establishes binding governance where none existed.

Principles defined:
  1. Concepts first: reuse, extend, or abstract before you build  (NON-NEGOTIABLE)
  2. Root cause, not duct tape                                     (NON-NEGOTIABLE)
  3. One source of truth
  4. Test-backed change (module tests, minimal mocking)
  5. Verification before completion
  6. Capability over identity
  7. Clean replacement over compatibility scaffolding
  8. Small, single-responsibility, DRY
  9. Git & operational safety

Dependent artifacts to keep in sync on amendment:
  - AGENTS.md (links here; must not restate principles)
  - .agents/skills/fleet-implement/SKILL.md  (Art. 4 wording: module tests, minimal mocking)
  - .agents/skills/fleet-plan/SKILL.md, .agents/skills/fleet-pr/SKILL.md
  - src/prompts/*-card-directive.ts + append-system-prompt.ts (injection of Art. 1–5)
  - docs/architecture/concepts/  (Art. 1 checks against this map)

TODO on next amendment: none.
-->

# Constitution

The non-negotiable core for anyone changing this codebase — human or agent. Kept deliberately short
and *normative* (MUST / SHOULD) so a plan, a review, or an analyze step can **check a change against
it**. This is the law; `AGENTS.md` holds the tribal knowledge and links here as the single source for
these principles — don't restate them there.

It is injected into every card session (design and build) and consulted by the architect when it
authors a card. Articles 1 and 2 matter most: they encode the engineering judgment we most want and
that agents most often skip.

---

## Article 1 — Concepts first: reuse, extend, or abstract before you build (NON-NEGOTIABLE)

**Before introducing anything new, consult the concept map (`concepts/`).** Then reason like a good
software engineer, in this order — do not skip to the last step:

1. **Do we already have something that fits?** → use it. Point at the canonical concept and its home.
2. **Something close but not quite?** → **extend** the existing concept, don't clone it with a
   variation.
3. **Two or more things converging on the same idea?** → introduce the right **abstraction** and fold
   the near-duplicates into it. Convergence is the signal to generalize.
4. **Genuinely new?** → *only then* add a new concept — deliberately, as a new `concepts/<name>.md`
   file in the same change.

You MUST NOT reimplement a **similar** concept as a near-duplicate with minor variations. That is the
single most expensive failure mode here: N slightly-different versions of the same idea. A new concept
is a **decision**, recorded in the concept map — never an accident.

**Rationale:** Fan-out codegen re-invents by default — each card starts cold. The concept map is the
shared memory that turns "build something" into "extend the one thing that already does this."

## Article 2 — Root cause, not duct tape (NON-NEGOTIABLE)

Agents tend to duct-tape symptoms. **We don't.** Before any fix, you MUST do root-cause analysis:

1. **What is the fundamental cause?** Not the surface symptom — the thing that, if removed, makes the
   symptom impossible.
2. **Is this local, or a design problem?** ALWAYS ask whether the current design still fits, or whether
   the bug is a sign the model is wrong. A recurring bug means the model is wrong.
3. **Would a better general solution remove the whole class of problem — and simplify things?** The
   deeper fix often *removes* code, config, or special-cases rather than adding a guard. Prefer it.

Two workarounds on the same surface is a **stop sign**: re-model the problem, don't patch it a third
time. Making a broken thing *loud* (better logging, a timeout that rethrows) is diagnosis, not a fix —
don't ship it as if the problem is solved. If while scoping a small fix you see the broader re-model
that would dissolve it, **say so** rather than quietly shipping the workaround.

**Rationale:** Patches stack into unmaintainable special-casing; the deeper fix usually removes code.
Symptom-chasing is how a wrong model survives — naming the cause is what lets us replace it.

---

## Article 3 — One source of truth

Every concern has exactly one owner (see `architecture.md` → "Who Owns What"). MUST NOT mirror state or
duplicate logic across layers. If a change feels awkward, ownership is usually being blurred — fix the
ownership, not the symptom (see Article 2).

## Article 4 — Test-backed change (module tests, minimal mocking)

MUST write tests first and watch them fail (RED) before implementing. **Prefer module tests** — exercise
a coherent module through its **external / public API** (Given / When / Then where there's a user-facing
surface) — over fine-grained unit tests bound to internals. When a module has external dependencies,
define a **clean, narrow interface** for each and mock **at that seam only**. Do not use excessive
mocking: a test drowning in mocks tests the mocks, not the behavior. The suite is the living spec — a
failing name should point at exactly one cause.

**Rationale:** Module-through-its-API tests survive refactors and read as the spec; internal-heavy
mocking couples tests to implementation and hides real behavior.

## Article 5 — Verification before completion

No "done / fixed / passing" claim without **fresh command output in the same turn** that shows it.
A card does not leave for Review on a self-report — it leaves on evidence.

**Rationale:** A self-reported "done" the board trusts is how broken work reaches Review. Evidence,
not confidence, gates a transition.

## Article 6 — Capability over identity

Prefer capability-oriented reasoning over `selectedAgentId === "cline"` branches. Keep the SDK behind
its boundary modules (`src/cline-sdk/`); only those modules may import `@clinebot/*`.

## Article 7 — Clean replacement over compatibility scaffolding

This area has no legacy users to migrate. Prefer clean replacement over backward-compatibility glue —
except at the persistence/wire boundary (`src/core/api-contract.ts` and the on-disk JSON), where
changes MUST stay additive / optional.

## Article 8 — Small, single-responsibility, DRY

No thin pass-through wrappers; extract domain logic (state, effects, orchestration), not
presentation-only shells. No `any`; use SDK-provided types, schemas, and helpers; no inline or dynamic
imports; upgrade a dependency rather than downgrade to satisfy a type error.

## Article 9 — Git & operational safety

Never commit or push unless asked; never push to `upstream` (only `origin`). Commit at coherent
incremental boundaries with semantic-commit prefixes; no destructive git (`reset --hard`, `clean -fdx`,
`worktree remove`, `rm`/`mv` on repo paths). Never target the live boards (ports 3500 / 3200) — verify
on a throwaway, isolated instance and tear it down.

---

## Governance

This constitution supersedes ad-hoc convention where they conflict; the codebase patterns it codifies
remain authoritative references.

- **Authority.** Articles 1–5 are the harness-level binding core, injected into every card and consulted
  by the architect; Articles 6–9 are fleet-kanban-specific. A plan, review, or the (planned) analyze
  gate MUST be checked against these; a conflict with a MUST is resolved by changing the design or the
  code, not by diluting a principle.
- **Amendments.** A change requires a PR with rationale and a version bump per the policy below, and MUST
  propagate to the dependent artifacts listed in the Sync Impact Report **in the same change** — the
  constitution and its injected skills/directives must never drift apart.
- **Versioning (SemVer for governance).** MAJOR = a principle removed or redefined incompatibly;
  MINOR = a new principle/section or materially expanded guidance; PATCH = clarifications and non-
  semantic refinements. Update the footer and the Sync Impact Report on every change.
- **Compliance.** Every PR and review verifies compliance. Added complexity or any deviation MUST be
  justified in-PR; unjustified violations block merge.

*Scope: this is fleet-kanban's constitution. Articles 1–5 are the harness-level core the architect
injects into every card in every managed repo; Articles 6–9 are fleet-kanban-specific. A managed repo's
repo-specific articles and concept map are resolved in-repo first, else from architect-owned doctrine at
the fleet root (`fleet-root/.fleet/doctrine/<repo>/`) so source repos stay pristine — see
[`../design/architect-doctrine-placement.md`](../design/architect-doctrine-placement.md). Repos extend
the core; they never override Articles 1–5.*

**Version**: 1.0.0 | **Ratified**: 2026-07-22 | **Last Amended**: 2026-07-22
