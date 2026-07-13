# Auto-build retro — first unattended architect run

**Date:** 2026-07-11 (overnight) · **Board:** live dogfood (:3500) · **Mode:** serial, auto-commit off, architect lands each card by hand.

Shipped 5 commits to `main` from a linked card chain — the architect reviewed, verified, and landed each one without a human in the loop.

| Commit | Card | Capability |
|--------|------|------------|
| `64bb716` | S1 | `fleet task say` — steer a running agent |
| `d55682a` | f2c88 | pre-commit self-scrubs the port-env leak |
| `5d7b458` | S2 | `needs_input` — "blocked, answer me" vs "done, review me" |
| `9a6f8aa` | O2 | `fleet task tail` — read a running agent's conversation |
| `724bbdf` | C1 | `--agent-model` — cheaper models for mechanical cards |

Net: the **steer + observe loop is closed** (say + tail) and the **biggest token lever** (per-card model) is in.

## What went well
- **Serial unattended landing worked.** 5 cards, one at a time, each verified (typecheck + full test suite + build where web-ui changed) before landing. Zero regressions.
- **Linked-card cascade** auto-started the next card on "done" (S2→O2→C1) with no manual kick.
- **Agents produced on-spec, well-tested code.** Two-tier tests (RED-first), additive/optional schemas that keep old `board.json` parsing, thin-wrapper/derive-state honored (tail reuses the existing transcript reader). The design doc's §-references kept them scoped.
- **f2c88 permanently killed the port-env papercut** — commits stopped tripping the hook mid-run.
- **The §12 hazard fix held** — every verify ran on an ephemeral instance; nothing touched the live board.
- **Safe landing protocol:** verify → fast-forward (or zero-overlap cherry-pick) → typecheck `main` → move to done. Never rebuilt the live `dist/`, so the running board was untouched all night.

## What went badly (friction / risk)
- **The landing mechanism is the fragile seam.** Kanban's built-in commit flow is an LLM narrating cherry-pick + stash + *stale-lock removal* on the **live `main` checkout**. It's too risky to trust unattended, so auto-commit was disabled and the architect landed everything manually — which means **the architect is the bottleneck; the pipeline isn't truly autonomous yet.**
- **Transient `index.lock` on C1** during its pre-commit test window (the live board/agent touched the shared checkout concurrently). Cost a diagnostic pause. Self-resolved; commit was intact. But it's a preview of what auto-commit would hit unattended.
- **Base drift.** Cards started on older `main` (S1's base moved; S2 was based on pre-f2c88 `main`), so some couldn't fast-forward — needed cherry-pick + manual overlap checks.
- **Cards stop at review *uncommitted*.** `/implement` is supposed to stop at a committed branch, but several left the worktree dirty — the architect had to commit in-worktree each time.
- **Biome nits block commits late.** S2's commit failed on an import-order lint the agent didn't run before stopping.
- **User-facing verbs aren't live yet.** `say`/`tail`/`--model` engines are on `main`, but need the parent-repo `fleet/fleet` wrapper (partly done, uncommitted) **and a live-board rebuild** before they can be exercised.
- **Observability was blind until O2 landed** — for most of the run the architect couldn't see *inside* a running agent, only its coarse state.

## What to test now
Rebuild the live board with the new `dist/`, then verify on an **ephemeral instance first** (per §12), then live:

1. **`fleet task say`** — steer a running card; confirm it reaches both a Cline session (discrete message) and a PTY/claude session (bracketed paste). Check `--no-submit` staging and the resume hint on an ended card.
2. **`needs_input`** — trigger a permission prompt; confirm the board shows the blue "Needs input" badge + the agent's question, and that answering via `fleet task say` returns the card to `running` (PTY pid stayed alive).
3. **`fleet task tail`** — read a running agent's conversation; check `--lines N` / `--since <mins>` and the no-transcript hint.
4. **`--agent-model` / `fleet task create --model claude-haiku-4-5`** — confirm the launched agent actually runs on that model (inspect process args / behavior); an explicit `--model` still wins; unset = today's default.
5. **f2c88** — confirm a normal agent commit now passes the pre-commit hook **without** scrubbing, even with `KANBAN_RUNTIME_PORT` set in the env.
6. **The pair, end-to-end** — use `tail` to spot a stuck/looping agent, then `say` to unstick it without restarting the card.
7. **Regression** — live-terminal raw typing, ended-card transcript view, and old `board.json` parsing are all unaffected by the additive schema changes.

## Architect wishlist — fix for the next iteration

Ranked by leverage. Each is grounded in friction actually hit this run, from the operator's seat.

**P0 — the autonomy blockers (why I still had to babysit)**
1. **Deterministic in-code landing routine.** Replace the LLM-narrated cherry-pick + stash + *stale-lock removal* on the live checkout with real git plumbing in code. This is *the* unlock: without it I can't trust auto-commit, so I am the bottleneck. Removes the index.lock/stale-lock risk class entirely.
2. **Land off the live checkout, or serialize against it.** C1's transient `index.lock` came from the landing commit racing the live board on the *same* `main` working tree. Land into a dedicated non-live checkout, or take a lock/queue against the board's git access. Never `rm` a lock to make progress.
3. **Cards must stop *committed*.** `/implement` claims to stop at a committed branch, but several left dirty worktrees — I had to commit-in-worktree every time. Make the review-stop actually commit (or make landing reliably handle an uncommitted worktree).

**P1 — freshness & quality of what agents hand me**
4. **Base-ref freshness.** Cards branched from stale `main` (S2 predated f2c88), forcing cherry-picks + manual overlap checks instead of clean fast-forwards. Rebase-on-start, or rebase at landing time, so a card's base is current `main`.
5. **Lint/format before the agent stops.** S2's commit failed late on a biome import-order nit. Run biome (with safe-fix auto-apply) in the agent's own wrap-up, so commits don't fail on formatting at landing.
6. **Automated verify gate.** I hand-verified every card (big diffs into my context = my token cost). A cheap verify-card/CI that runs build+tests+`/code-review` and only escalates *failures* would keep me out of the green path.

**P2 — observability & signals (so I know when to act)**
7. **Push, don't poll.** I watched for "card → review" with background pollers. A real event/notification when a card changes state would be cleaner and cheaper on my context than 25s polls.
8. **Richer running-state + token burn.** Coarse `running/idle` doesn't tell me *productive* from *stuck*. Surface live tail on the board (now that O2 exists) and a per-card token counter, so I can catch waste before it compounds.

**P3 — root causes & deferred**
9. **Don't leak `KANBAN_RUNTIME_PORT` into child sessions at all.** f2c88 patched the hook, but the board still injects its runtime port into every agent's env. Strip runtime env when spawning sessions — fixes the class, not just the symptom.
10. **Tighten the engine↔wrapper↔rebuild loop.** A feature (say/tail/model) landed in fleet-kanban but isn't testable until the parent-repo `fleet/fleet` wrapper *and* a live-board rebuild catch up. Too many manual steps between "landed" and "usable."
11. **`--think` / C1b** — deferred pending decision D-C (native thinking knob).
12. **Change-index / primed context** — stop agents re-learning the tree every card (the other half of token economy).

**If only one thing ships next: P0-#1 (deterministic landing).** It converts this run's "architect babysits every landing" into a pipeline that actually runs itself — everything else is optimization on top of that.
