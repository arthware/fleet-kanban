# RFC: use a project's GitHub issues as the source of truth for board cards

**Card ref / slug decision.** No external issue is set on this card, so the ref falls back to the card
id `bf91c` and the slug is `github-issues-as-card-source` → `docs/design/bf91c-github-issues-as-card-source.md`.

**Status:** design only. This RFC proposes the design; it does not implement it.

---

## Problem statement

Today the **local card is the source of truth**. A card may *carry* a link to a GitHub or Linear
issue via its optional `externalIssue` field, but that link is **decorative** — it feeds a chip in the
UI and a CLI lookup, and nothing else. Nothing flows from the issue into the card, and nothing flows
from a newly-created card back out to GitHub.

The consequence is **two disconnected backlogs**: a team that already tracks work in GitHub Issues /
Projects must hand-transcribe each item into a board card (and keep them in sync by hand), or abandon
GitHub and drive everything from the board. There is no shared list.

We want an **opt-in, two-way integration** with a project's GitHub issues, gated on `gh` being
available and the project's doctrine/config electing into it:

- **Inbound (issue → card):** issues labeled **`fleet`** surface as cards; the issue (title + body) is
  the card's definition. The issue is authoritative for *what the work is*.
- **Outbound (card → issue):** creating a card on the board surfaces a **`fleet`-labeled issue added
  to the project's GitHub Project (Projects v2)**, so the Project and the board are one backlog.

The root cause of the "two lists" problem is not a missing feature so much as a **mis-modeled
ownership boundary**: the card owns the work definition, when for GitHub-driven teams the *issue*
should. The fix is to **invert the existing `externalIssue` link from decorative to authoritative** —
not to introduce a second issue model. This must happen **without regressing** the current local-card
flow for repos that don't opt in, and **without a flood of `gh` calls** (a hard non-functional
requirement).

---

## What exists in the codebase

The building blocks already exist; this feature is mostly **inverting and reusing** them, per
Constitution Article 1 (reuse/extend before build) and Article 3 (one source of truth).

### The link to invert — `external-issue`

- **Concept:** `docs/architecture/concepts/external-issue.md` — "an optional link from a card to its
  source-of-record issue… informational only."
- **Schema:** `src/core/api-contract.ts:181` `runtimeExternalIssueProviderSchema = z.enum(["linear","github"])`;
  `:184` `runtimeExternalIssueSchema = { provider, key, url?, raw }`; `:226` it is an **optional** field
  on `runtimeBoardCardSchema`. Schema is **both wire and on-disk** (`board.json`) — changes must stay
  additive/optional (Article 7).
- **Parser:** `src/core/external-issue.ts` `parseExternalIssueRef(raw)` already recognizes GitHub
  `owner/repo#n` (`GITHUB_OWNER_REPO_ISSUE_PATTERN`), bare `#n`, GitHub issue URLs (`parseGithubIssueUrl`),
  and Linear keys/URLs — normalizing to a canonical `{provider, key, url?, raw}`.
- **Identity / dedup foothold:** `src/commands/task.ts:423` `resolveCardIdFromRefOrIssue` already maps a
  ref to a card by `task.externalIssue?.key === ref`, and **throws when two cards share a key** — i.e.
  the "one card per issue key" invariant is already half-enforced here.
- **Create/update carry it through:** `RuntimeCreateTaskInput.externalIssue`
  (`src/core/task-board-mutations.ts:31`) is cloned onto the card in `addTaskToColumn` (`:351`, `:362`);
  `updateTask` (`:702`) supports set/clear. `git log` on `external-issue.ts` → introduced by
  `40b7bdf feat(kanban): correlate cards with external issues`.

### The sync engine to mirror — the PR poller

The board **already polls GitHub and reconciles remote state onto cards**. An issue poller is the same
shape, so we reuse this machinery rather than build a parallel one (Article 1).

| Concern | Where | What it does |
|---|---|---|
| Batched `gh` read | `src/workspace/card-pr-url.ts` | `listRepoCardPrsByHead({cwd})` runs **one** `gh pr list --state all --limit 200 --json headRefName,url,state,number,statusCheckRollup` per repo (`GH_REPO_PR_LIST_ARGS`), 5s timeout (`GH_COMMAND_TIMEOUT_MS`), returns `Map<headRefName, CardPrRef>`. Injectable `GhRunner` for tests. |
| Poll loop + caches | `src/server/workspace-metadata-monitor.ts` | 1s poll (`WORKSPACE_METADATA_POLL_INTERVAL_MS`); **one in-flight fetch** shared via `entry.refreshPromise`; `capturedPrTaskIds` (capture-once) + `prResolveAttemptedAtByTaskId` (30s retry) + `lastPrCheckedAtByTaskId` (60s `PR_STATE_REFRESH_MIN_MS`); gh runs **after** the broadcast so it's off the render path; timers `unref()`; `subscriberCount` gates polling to connected viewers. |
| Reconcile onto card | `src/core/task-board-mutations.ts:754` | `setCardPrUrl(board, taskId, pr)` — **idempotent**: returns `updated:false` when the card already holds that exact PR, so no needless disk write. |
| Deterministic key | `deriveTaskBranchName({taskId, externalIssueKey, title, prompt})` (`workspace-metadata-monitor.ts:105`) | The reconcile key. From prior art **`81f44c3` fix: detect card PRs by branch** — a card gets a deterministic branch so remote detection has a reliable join key. |

**Prior-art SHAs read:**
- `81f44c3` — *detect card PRs by branch*: replaced fragile per-card lookups with **one repo-wide
  `gh pr list` keyed by branch head**. This is the exact "one batched list → reconcile by key" shape
  the inbound poller should copy.
- `c1d891e` — *drive auto-pr through fleet-pr skill*: shows the card→PR write path and the
  frontmatter/skill plumbing (`task-card-frontmatter.ts`) that the outbound issue-body frontmatter can
  reuse.

### One-shot issue→card precedent — `fleet` CLI

- `fleet agent plan <ENG-ID>` (`fleet-cli/fleet:~992`) turns a **Linear** issue into a design card via
  `kanban task create … --external-issue`, and `fleet linear [--assigned|--created]` lists Linear
  issues. This proves the import direction and the `--external-issue` stamping, but it is **one-shot
  and Linear-only**. The new feature is a **live, label-filtered** GitHub source. Note what
  generalizes (stamp `externalIssue` at create; dedup by key) vs. what is GitHub/`gh`-specific.

### Durable card vs. ephemeral session

- Concepts `task-card.md`, `task-session.md`, `card-lifecycle.md`: a **card** is the durable definition
  (`prompt`, `baseRef`, agent selection, review settings, `transitions`); a **session** is the ephemeral
  compute; **columns** are `["backlog","in_progress","review","done","trash"]`, each move appending a
  `transitions` entry. This split is central: an **issue is a natural durable card definition**, while
  execution/column state is derived locally.

### Opt-in / config + doctrine surface

- Two config files exist. `src/config/runtime-config.ts:213` `getRuntimeProjectConfigPath` →
  **`.cline/kanban/config.json`** (already parses `worktree.postCreateCommand` etc. with strict
  `normalize*` helpers). `fleet init` writes **`.fleet/config.json`** and scaffolds `AGENTS.md`.
- `src/prompts/doctrine.ts` `loadDoctrine` resolves a repo's constitution in-repo first, else
  architect-owned root doctrine — the pattern for "repo-scoped config with a fleet-root fallback."

---

## Proposed solution

Introduce a **card-source mode** per repo. When a repo opts into `github-issues`, a new **issue-source
reconcile loop** (a sibling of the PR poller) makes labeled GitHub issues the authoritative definition
of cards, and card creation surfaces an issue back to the project's GitHub Project. The two directions
share **one identity** (`externalIssue.key`) so neither echoes the other. Below are the concrete
decisions, each with a recommendation.

### 1. Issue → card field mapping

| Card field | Source | Notes |
|---|---|---|
| `id` | local (generated) | Cards keep their own id; the issue is joined via `externalIssue.key`, not by reusing the number as id. |
| `externalIssue` | `{provider:"github", key:"owner/repo#n", url, raw}` | Built with the **existing** `parseExternalIssueRef`. This is the identity. |
| `title` | issue title | |
| `prompt` | issue body (frontmatter stripped) | The body **minus** the fenced control block below. |
| `tags`/labels | issue labels (minus `fleet`) | Informational; may map to nothing in v1. |
| `agentId`, `agentModel`, `baseRef`, `autoReviewMode`, `skill` | **fenced frontmatter block in the issue body** | See below. Falls back to per-repo defaults from config. |

**Recommendation for execution knobs: a fenced `fleet` frontmatter block in the issue body**, e.g.

````markdown
```fleet
agent: codex
model: gpt-5
base-ref: production-line
auto-review: pr
```
````

Chosen over dedicated labels (which pollute the label namespace, can't express a base ref cleanly, and
cap at GitHub's label set) and over per-repo-defaults-only (too coarse — every card would be identical).
Frontmatter is **lossless and round-trippable** (outbound writes the same block), and there is an
existing parser to model it on: `src/commands/task-card-frontmatter.ts` already parses YAML card
frontmatter for markdown cards. Missing keys fall back to **per-repo defaults** in config
(`default_agent`, `default_base_ref`, `default_auto_review`). This reuses the markdown-card concept
rather than inventing a second one (Article 1).

### 2. Column / lifecycle mapping

GitHub issues have `open`/`closed` + labels, not kanban columns.

**Recommendation: the issue is the durable *definition*; the column stays *derived from local
session/PR state*, exactly as today.** GitHub is the SoT for *what the work is*; the board remains the
SoT for *where the work is*.

| Column | Derived from |
|---|---|
| `backlog` | issue is `fleet`-labeled and open, no local session started yet |
| `in_progress` | a local session is attached/running (existing `task-session` lifecycle) |
| `review` | session ended for review + PR gate (existing) |
| `done` | the card's PR merged **or** the issue closed (whichever the poller sees first) |
| removed from board | issue loses the `fleet` label or is deleted (see §4) |

Rejected alternatives: **a GitHub status label** (round-trips column state through labels — noisy,
racy, and duplicates local lifecycle state, violating Article 3); **a Projects v2 status field as SoT
for the column** (couples our column machinery to a Projects schema we don't control, and forces a
`gh` write on every local move — the opposite of the "few `gh` calls" requirement). We *may*
**mirror** the derived column into a Projects v2 status field as a phase-2, best-effort write-back
(§6), but the board never *reads* its column from GitHub.

### 3. Toggle & detection

**Recommendation: put the toggle in `.cline/kanban/config.json`** (the file the runtime already parses
with strict normalizers) under a new `cardSource` block, **per repo**:

```jsonc
{
  "cardSource": {
    "provider": "github-issues",     // default: "local"
    "issueLabel": "fleet",           // default label
    "repo": "owner/repo",            // optional; else inferred from git remote
    "defaults": { "agent": "codex", "baseRef": "production-line", "autoReview": "pr" },
    "pollIntervalMs": 120000         // optional; see §4
  }
}
```

`AGENTS.md` documents it; the machine-read source is config (keeping doctrine prose and machine config
separate — doctrine is for agents, config is for the runtime). Detection: read the config, then probe
`gh` availability/auth **once per process** (`gh auth status`, cached) exactly as `card-pr-url.ts`
already guards on `hasGitRemote`. **Graceful fallback:** if `provider` is absent/`"local"`, or `gh` is
missing/unauthed, the issue loop **never starts** and the board behaves exactly as today. This makes
the feature a *mode*, not a rewrite (Article 7 — clean opt-in, no compat scaffolding for non-users).

*(Open question in §Open questions: whether the toggle should instead live in `.fleet/config.json` for
consistency with `fleet init`. Recommendation leans to `.cline/kanban/config.json` because the runtime
already owns and validates it.)*

### 4. Sync loop & reconciliation — performance is a hard requirement

Model the inbound loop as a **sibling of the PR poller**, reusing its caching discipline. The **entire
board — every viewer, every card, every refresh — fans into one shared, cached, batched issue read per
repo.**

- **One batched list call per repo per cycle** (never N, never per-issue):
  ```
  gh issue list --label fleet --state all \
    --json number,title,body,labels,state,updatedAt --limit 200
  ```
  Everything needed to build **every** card comes back in one shot — **no N+1 per-issue detail
  fetch**. New module `src/workspace/card-issue-source.ts` mirrors `card-pr-url.ts`: injectable
  `GhRunner`, 5s timeout, strict parse → `Map<issueKey, IssueCardDef>`.
- **One in-flight fetch + TTL cache, shared by all readers.** Reuse the `refreshPromise` in-flight-dedup
  already in `workspace-metadata-monitor.ts`, plus a TTL so a warm cache serves UI polls without a
  fresh `gh` call — the same server-side-cache discipline as the budget readout (card `0759b`,
  `docs/design/per-card-token-usage.md`: 10-min cache + in-flight dedup). Concurrent viewers share one
  result.
- **Changed-since fetching.** Keep a **last-synced watermark** and reconcile only issues whose
  `updatedAt` moved since the last poll (optionally `--search "updated:>=<watermark>"`), instead of
  re-reading the world each cycle.
- **Idle cost near zero.** Cadence configurable (`pollIntervalMs`, default ~2 min) and **backs off when
  idle** and when `subscriberCount === 0` (no viewers → no polling), exactly like the PR poller.
- **Explicit non-functional target:** **≤ 1 `gh issue list` call per repo per poll interval, regardless
  of card count or viewer count** (steady-state ≈ one call / 2 min / repo). Per-card, per-issue, or
  per-viewer polling is **rejected on principle**.
- **Phase-2: webhooks.** A GitHub webhook (issue opened/edited/labeled/closed) pushed to the runtime
  drops steady-state `gh` calls to ~0. Noted as a later phase; **not required for v1**.

**Reconcile semantics** (idempotent, mirroring `setCardPrUrl`):

| Issue event | Board effect |
|---|---|
| New `fleet`-labeled issue | Create a backlog card stamped with `externalIssue.key` **iff** no card already has that key (reuse the `resolveCardIdFromRefOrIssue` dedup rule). |
| Issue body/title edited | Update the card's `prompt`/`title` via `updateTask` — **only if the card hasn't started** (an in-flight session shouldn't have its prompt yanked; open question §Open questions on edits after start). |
| Issue closed | Move card to `done` (if not already terminal). |
| Issue loses `fleet` label / deleted | Recommend **archive to `trash`** (non-destructive; trash is archive not delete per `card-lifecycle.md`), not hard-delete — a deleted issue shouldn't silently destroy local session history. |

**Identity/dedup:** exactly one card per `externalIssue.key`. The existing filter in `task.ts:423` is
the enforcement point; the poller consults it before creating.

### 5. Coexistence vs. replacement

The ask is "use them **instead of** local cards." **Recommendation: per-repo mode is either/or.** When
a repo's `cardSource.provider === "github-issues"`:

- Labeled issues **are** the cards; **local card creation on that repo is redirected outbound** (§6) —
  creating a card creates the issue, which then reconciles back as the card (no separate local-only
  card).
- **Pre-existing local cards** without an `externalIssue` are left in place and **untouched** (they
  keep working), but the UI surfaces a one-time notice that new work is issue-sourced. We do **not**
  auto-migrate them (that would require inventing issues for historical cards — out of scope; can be a
  manual `fleet` command later).
- Repos left in the default `local` mode are **completely unaffected**.

This keeps the mode clean (Article 7) without stranding existing work.

### 6. Outbound (card → issue / Project) — required

When a card is created in a `github-issues` repo, surface it to GitHub:

1. **Create the issue:** `gh issue create --label fleet --title <card title> --body <body>`, where the
   body is `card.prompt` **plus the fenced `fleet` frontmatter block** encoding
   `agent/model/base-ref/auto-review` — the *same* channel inbound reads (§1), so a round-trip is
   lossless.
2. **Add to the Project (v2):** a **separate** step — `gh project item-add <project-number> --owner
   <owner> --url <issue-url>` (or the GraphQL `addProjectV2ItemById`, which needs the project **node
   id**). The project is **configured** (`cardSource.project`, a number or URL) or discovered once and
   cached; adding to a Project v2 is not implied by issue creation.
3. **Stamp identity immediately (the anti-loop invariant):** the moment the issue is created, write its
   `externalIssue.key` onto the just-created local card (via the existing create path, which already
   accepts `externalIssue`). Now the inbound reconcile sees a card that **already owns that key** and
   **does not re-import it as a second card**. This is the same idempotency guarantee `setCardPrUrl`
   gives for PRs. **Invariant: a card and its issue are one identity keyed by `externalIssue.key`;
   neither direction creates a duplicate of what the other just made.**
4. **Failure handling:** the local card **always exists first**; issue creation is a **best-effort,
   queued/retried** side effect (mirror `captureTrackedCardPrs` — "a gh/persist failure just means
   retry on a later refresh"). A failed `gh` write **must not lose the card or wedge creation**; the
   card is marked "issue pending" and retried on the next reconcile cycle (with backoff).
5. **Other write-backs (phase-2, may be deferred):** close the issue on `done`; comment the PR link on
   the issue; mirror the derived column into a Projects v2 status field (§2). These are **lower
   priority** than create-surfacing and can ship later.

### 7. Generalization (Article 1)

GitHub and Linear already share the `external-issue` provider union, and a Linear one-shot import
exists. **Recommendation: define a thin `RemoteIssueSource` seam now, implement GitHub against it, and
leave Linear as a documented future implementor — without porting Linear in this feature.**

```ts
interface RemoteIssueSource {
  provider: RuntimeExternalIssueProvider;
  listCards(input: { repo: string; label: string; since?: string }): Promise<Map<string, IssueCardDef>>;
  createIssueForCard(card: IssueCardDef): Promise<RuntimeExternalIssue>;
}
```

This avoids a **near-duplicate** of the Linear code (Article 1's worst failure mode) while not
over-abstracting: the seam is exactly the two operations the reconcile loop needs. The GitHub
implementation is the `gh`-backed module; Linear can plug in later behind the same interface. If, at
build time, the seam proves speculative, the fallback is a GitHub-only path — but the union already
existing makes the seam cheap.

### 8. Safety & trust surface

- **`gh` auth/permissions/private repos:** probe `gh auth status` once; degrade to local-card behavior
  when unauthed or lacking `repo`/`project` scope. Private repos work as long as `gh` is authed for them.
- **Rate limits:** the batched-one-call-per-interval design (§4) keeps us far under GitHub's limits;
  respect `gh` rate-limit errors by backing off (the poller already swallows `gh` failures and retries).
- **Prompt-injection / trust boundary (important):** an **issue body becomes an agent prompt**, authored
  by anyone with repo (issue-write) access. This is a real trust-surface expansion — a hostile issue
  could carry adversarial instructions. Bound it: **the constitution is still prepended** to every card
  prompt (doctrine.ts), the issue body is treated as *untrusted task text* (documented as such to the
  agent), and — recommended — **only issues from repo collaborators / with the `fleet` label applied by
  a trusted role** are surfaced (a `trustedAuthorsOnly` config gate). Call this out prominently in
  `AGENTS.md`; it is the one genuinely new risk this feature introduces.

---

## Technical rationale

- **Invert an existing link, don't add a model.** The card↔issue relationship already exists as
  `externalIssue` with a parser, a shape, and a dedup filter. Making it *authoritative* reuses all
  three; a second "issue" abstraction would violate Article 1 (near-duplicate concept) and Article 3
  (two owners of the same relationship).
- **The sync is the PR-poller pattern again.** Issue reconciliation is structurally identical to PR
  reconciliation the board already does: one batched `gh` read → reconcile by a deterministic key →
  broadcast, with an in-flight-dedup + TTL cache and `subscriberCount` gating. Reusing
  `card-pr-url` / `workspace-metadata-monitor` / `setCardPrUrl` avoids a parallel engine and inherits
  its hard-won cost discipline.
- **Issue = durable definition, session/column = derived.** This aligns with the card-vs-session
  decoupling the codebase already models (`task-card` / `task-session` / `card-lifecycle`). GitHub owns
  *what the work is*; local state owns *where it is*. It sidesteps the doomed attempt to store kanban
  columns in GitHub.
- **`gh` is the cost center.** Every viewer/card/refresh must fan into **one** shared, cached, batched
  read per repo. A per-card/per-issue/per-viewer design is rejected on principle; the poller pattern +
  TTL cache + changed-since watermark is exactly the shape that meets the "≤1 list call / repo /
  interval" target, mirroring why the budget readout caches server-side (card `0759b`).
- **Opt-in and non-invasive.** Repos that don't set `cardSource` (or lack `gh`) keep the exact current
  behavior — clean replacement for opt-in users, zero compat scaffolding for everyone else (Article 7).

**Key risks:** (1) **prompt-injection** via issue bodies (§8) — the one new trust surface, mitigated by
constitution-prepend + trusted-author gating; (2) **loop/duplicate** between inbound and outbound —
dissolved by the single-identity `externalIssue.key` invariant and immediate stamping (§6.3); (3)
**Projects v2 plumbing** (node ids, separate item-add step, scopes) is the fiddliest `gh` surface —
isolate it behind the `RemoteIssueSource` seam and make Project-add best-effort; (4) **edit-after-start**
races on the prompt (see Open questions).

---

## Open questions

1. **Config home:** `.cline/kanban/config.json` (runtime-owned, already validated — recommended) vs.
   `.fleet/config.json` (consistent with `fleet init`)? Or write to `.fleet/config.json` and have the
   runtime read both?
2. **Edit-after-start:** if an issue body is edited **after** a session has started, do we (a) ignore
   the edit, (b) update the card prompt but not the running session, or (c) surface a "definition
   drifted" badge? Recommendation leans (c) — visible, non-destructive.
3. **Deletion semantics:** issue loses `fleet` label vs. issue hard-deleted — both → `trash`, or treat
   label-loss as "archive" and deletion as "orphan/keep with a warning"?
4. **Projects v2 discovery:** require an explicit `cardSource.project`, or auto-discover the repo's
   default project? Auto-discovery needs extra scopes and a `gh` call — probably explicit config for v1.
5. **Trusted-author gating default:** on or off by default? Off is more convenient but widens the
   prompt-injection surface; recommendation is **on** for public repos, configurable.
6. **Watermark durability:** persist the last-synced watermark where — in `board.json`, a sidecar, or
   in-memory only (re-scan on restart)? In-memory is simplest for v1; a full re-scan on restart is one
   extra call.

---

## Disposition

**Hand back to the architect to fan out build cards**, phased for risk/size (not by dropping the
outbound half — both directions are in scope):

- **Phase 0 — seam + config + detection.** `RemoteIssueSource` interface, `cardSource` config parsing in
  `runtime-config.ts`, `gh` availability probe, and graceful fallback to local mode. No behavior change
  for non-opters. (Small, low-risk foundation.)
- **Phase 1 — inbound reconcile.** `card-issue-source.ts` (one batched `gh issue list`), wire into the
  metadata monitor's cached/in-flight-deduped loop with a changed-since watermark, reconcile issues →
  cards by `externalIssue.key`, derive columns locally. Meets the ≤1-call/repo/interval target. (The
  core; mirrors the PR poller.)
- **Phase 2 — outbound create-surfacing.** On card create in issue-mode: `gh issue create --label fleet`
  + `gh project item-add`, immediate `externalIssue` stamping (anti-loop), best-effort retry/queue on
  failure. (The trickier `gh`-write + Projects v2 surface.)
- **Phase 3 — write-backs & webhooks.** Close-on-done, PR-link comment, Projects v2 status mirror, and
  webhook push to drive steady-state `gh` calls to ~0.

Each phase is independently shippable and testable behind the opt-in flag, so the live local-card flow
is never at risk.
