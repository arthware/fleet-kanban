<!--
SYNC IMPACT REPORT
==================
Version change: 1.0.0 → 1.0.1
Bump rationale: 1.0.1: Compress and tighten Article prose to halve injected per-card token cost without altering meaning.

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

**Before introducing anything new, consult the concept map (`concepts/`).** Reason in this exact order:
1. **Fit exists?** → Reuse it and point to its canonical concept home.
2. **Close but not quite?** → **Extend** the existing concept; do not clone with variations.
3. **Convergence?** → Introduce the right **abstraction** and fold near-duplicates into it.
4. **Genuinely new?** → Only then add a new concept deliberately as `concepts/<name>.md` in the same change.

You MUST NOT reimplement a similar concept as a near-duplicate with minor variations.
**Rationale:** Standard codegen reinventing by default creates N slightly different versions of the same idea; the concept map is our shared memory to extend the one thing that already does this.

## Article 2 — Root cause, not duct tape (NON-NEGOTIABLE)

We do not duct-tape symptoms. Before any fix, you MUST analyze the root cause:
1. **Fundamental cause:** Identify the underlying issue that, when removed, makes the symptom impossible.
2. **Local vs. Design:** Ask if the design still fits. A recurring bug indicates a wrong model.
3. **General solution:** Prefer a deeper fix that simplifies or removes code over adding a conditional guard.

Two workarounds on the same surface is a **stop sign**: remodel the problem, do not patch a third time. Making a broken thing *loud* is diagnosis, not a fix. If a broader remodel would dissolve the bug, **say so** instead of quietly shipping a workaround.
**Rationale:** Special-casing stacks unmaintainably; naming the cause and fixing the model removes code and prevents symptoms from surviving.

---

## Article 3 — One source of truth

Every concern has exactly one owner (see `architecture.md` → "Who Owns What"). MUST NOT mirror state or duplicate logic across layers. If a change feels awkward, ownership is blurred: fix the ownership, not the symptom.

## Article 4 — Test-backed change (module tests, minimal mocking)

MUST write tests first and watch them fail (RED). **Prefer module tests** exercising a coherent module through its **public API** (Given/When/Then) over internal-bound unit tests. Mock only at clean, narrow interfaces for external dependencies; avoid excessive mocking. The test suite is the living spec where a failing name points to exactly one cause.
**Rationale:** API-level tests survive refactors and serve as the spec, whereas excessive internal mocking couples tests to implementation and hides real behavior.

## Article 5 — Verification before completion

No "done / fixed / passing" claim without **fresh command output in the same turn** showing it. Cards leave for Review only on evidence, never self-reports.
**Rationale:** Self-reported completions bypass validation; only empirical evidence gates transitions safely.

## Article 6 — Capability over identity

Prefer capability-oriented reasoning over `selectedAgentId === "cline"` branching. Keep the SDK isolated behind `src/cline-sdk/`; only boundary modules may import `@clinebot/*`.

## Article 7 — Clean replacement over compatibility scaffolding

Prefer clean replacement over backward-compatibility glue. The only exception is the persistence/wire boundary (`src/core/api-contract.ts` and on-disk JSON), where changes MUST remain additive and optional.

## Article 8 — Small, single-responsibility, DRY

Extract domain logic (state, effects, orchestration) instead of presentation wrappers. Use SDK types/schemas/helpers and never use `any`. No inline/dynamic imports. Upgrade dependencies rather than downgrading to resolve type errors.

## Article 9 — Git & operational safety

Commit incrementally with semantic prefixes. Never push to `upstream` (only `origin`). No destructive git commands (`reset --hard`, `clean -fdx`, `worktree remove`, or `rm/mv` on repo paths). Never target live boards (ports 3500/3200); verify on throwaway instances and tear them down.

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

**Version**: 1.0.1 | **Ratified**: 2026-07-22 | **Last Amended**: 2026-07-27
