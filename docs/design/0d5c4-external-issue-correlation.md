# 0d5c4 — Correlate a Kanban card with an external issue (Linear / GitHub)

**Status:** design — ready for `/implement`
**Card:** `0d5c4`
**Branch:** `0d5c4-external-issue-correlation`

## Problem & desired outcome

A Kanban card is minted with an internal 5-char hex id and has no way to record
that it corresponds to a **tracked issue elsewhere** — a Linear issue (`ENG-123`)
or a GitHub issue (`#123`, `owner/repo#123`, or a full URL). Operators who run the
board alongside Linear/GitHub can't see, at a glance, which upstream issue a card
serves, and can't jump from the card to the source of record.

**Good outcome:** a card can carry an optional reference to one external issue;
the board shows it as a small chip alongside the existing agent/model/plan chips;
and the chip deep-links to Linear/GitHub when we can resolve a URL. Setting it is a
one-flag `task create`/`task update`, and it never changes how a card is stored,
worktree'd, or routed.

The seed question — *"can the card id itself BE the issue id?"* — is evaluated
first (Options A/B below) and **rejected** in favour of a dedicated correlation
field (Option C, recommended).

---

## Investigation — how the card id is used today (cited)

The id is a **durable, opaque key**, minted randomly, and load-bearing in several
places. This is what determines whether it can double as a user-supplied issue id.

- **Minting + collision retry.** `createShortTaskId` takes a 5-hex slice of a UUID;
  `createUniqueTaskId` retries up to 16× against the set of existing ids, then falls
  back to a random base-36 slice (`src/core/task-id.ts:1-17`). The whole design
  **assumes the minter controls the value** and can retry on collision.
- **Where it's assigned.** `addTaskToColumn` sets `id: explicitTaskId ||
  createUniqueTaskId(...)` and rejects an `explicitTaskId` that already exists
  (`src/core/task-board-mutations.ts:305-311`). So an explicit id is already
  *possible*, but uniqueness is the caller's problem.
- **Worktree directory path.** The id is a path segment:
  `worktrees/<taskId>/<workspaceLabel>`. `normalizeTaskIdForWorktreePath` **throws**
  if the id contains `/`, `\`, or `..` (`src/workspace/task-worktree-path.ts:8-14`,
  consumed at `src/workspace/task-worktree.ts:123-138`).
- **Patch filenames.** The id is the prefix of the durable patch file
  `<taskId>.<commit>.patch` (`src/workspace/task-worktree.ts:141-142,236`).
- **No per-task git branch.** Worktrees are created **detached** (`git worktree add
  --detach …`, `src/workspace/task-worktree.ts:522,537`). There is *no* branch named
  after the id, so "branch-name safety" reduces to **directory/filename safety only**.
- **Routing / UI.** The id is SPA state, matched by equality against `card.id`
  (`web-ui/src/App.tsx:909` `selectedTaskId={selectedCard?.card.id ?? null}`), not a
  URL path segment — so there is no route-format regex to satisfy. Only `task-id.ts`
  encodes the length `5`; nothing else validates id shape.
- **Prior-art pattern for "external ref on a card."** `prUrl`/`prState`/`prNumber`
  were added as **optional** fields on `runtimeBoardCardSchema`
  (`src/core/api-contract.ts:149-156`), plumbed through a dedicated idempotent
  mutation `setCardPrUrl` (`task-board-mutations.ts:660-714`), normalized as
  optional passthrough in the web model (`web-ui/src/state/board-state.ts`,
  `web-ui/src/types/board.ts`), and rendered as a compact deep-link
  (`web-ui/src/components/board-card.tsx`, PR link block). This is the exact shape we
  reuse. Chip/badge rendering pattern: the `mt-1 flex … gap-1.5` badge row from the
  Plan/completion-policy badges (commit `2eeeebb`).

### What breaks if the id itself is `ENG-123` / `#123` / a URL

| Concern | Verdict |
|---|---|
| Full URL & `owner/repo#123` contain `/` | **Hard break** — `normalizeTaskIdForWorktreePath` throws → worktree creation fails. |
| `#123` as a path segment | Works dir-wise, but `#` is awkward in shells/paths and in the patch filename; fragile. |
| Uniqueness | **Breaks the model.** GitHub `#123` is not unique across repos; you frequently want **several cards per issue** (a design card + impl cards), which one id can't express. Collision-retry is meaningless for a user-chosen id. |
| Correlating an *existing* card | **Not possible** — the id is the durable on-disk key (worktree dirs, patch files, transcripts). Renaming it to an issue id would orphan all of that. |
| Mixed id space | Net-new internal cards (most of them) still need hex, so you'd get a hex/`ENG-123` mix — losing the clean invariant for no gain. |

**Conclusion:** the id must stay an internal, minter-controlled, path-safe key. Issue
correlation is a *separate, optional attribute*.

---

## Options considered

### Option A — Overload the id with the issue id
Make `ENG-123`/`#123`/URL the card id. **Rejected** — breaks worktree path safety
(slashes), uniqueness/collision-retry, multiple-cards-per-issue, and late
correlation of existing cards (see table). Highest blast radius, least reversible.

### Option B — Human alias baked into the id (`ENG-123__a1b2c`)
Keep a hex suffix for uniqueness/path-safety but prefix a human token. **Rejected** —
still slash-unsafe for URLs/`owner/repo#123`, still can't be added after creation,
and every id consumer now has to parse structure out of a key that was meant to be
opaque. Complexity with no upside over Option C.

### Option C — Dedicated optional correlation field *(recommended)*
Keep the internal hex id untouched. Add one optional `externalIssue` field to the
card, settable at create and editable via update, rendered as a deep-linking chip.
Mirrors the proven `prUrl` pattern exactly. Lowest risk, fully back-compatible,
reversible (clear the field), supports many cards → one issue and late correlation.

**Recommended: Option C.** On the prompt's "hybrid is fine / optionally allow the id
to carry a human alias" — we deliberately **do not** overload the id. The correlation
field *is* the human-facing alias; the id stays a pure internal key. That is the
hybrid, minus the one part (aliased id) that reintroduces Option A/B's breakage.

---

## Design (Option C)

### Schema field

Add one optional, structured field to `runtimeBoardCardSchema`
(`src/core/api-contract.ts`, beside `prUrl`):

```ts
// A single external issue this card corresponds to (Linear or a GitHub issue),
// for cross-linking the board to the source of record. Optional and purely
// informational — it never affects id minting, worktree paths, or routing. A
// board.json written before this field existed still parses.
export const runtimeExternalIssueProviderSchema = z.enum(["linear", "github"]);
export type RuntimeExternalIssueProvider =
	z.infer<typeof runtimeExternalIssueProviderSchema>;

export const runtimeExternalIssueSchema = z.object({
	provider: runtimeExternalIssueProviderSchema,
	// Canonical display key: "ENG-123" (linear), "owner/repo#123" or "#123" (github).
	key: z.string(),
	// Absolute deep-link, resolved at set-time when derivable; omitted otherwise.
	url: z.string().optional(),
	// The raw operator input, preserved so we can re-derive if resolution rules change.
	raw: z.string(),
});
export type RuntimeExternalIssue = z.infer<typeof runtimeExternalIssueSchema>;
```

Then on the card object: `externalIssue: runtimeExternalIssueSchema.optional(),`.

**Why a nested object over 3 flat fields (as `prUrl` did):** an issue ref genuinely
has structure (provider + key + optional url) that is always read together and never
independently; one optional object keeps the card schema tidy and the web
normalizer/type in lockstep. This is the small deviation from the `prUrl` precedent,
and it is justified by cohesion.

**Back-compat & migration.** Purely additive and `.optional()` — a board.json without
the field parses unchanged (same guarantee `prUrl` relies on). **No data migration or
`.transform()` step is needed** (contrast `d671167`, which needed a transform only
because it *changed* an existing column's meaning). New cards simply omit it.

### Parsing / normalization

A pure, synchronous helper (new `src/core/external-issue.ts`, unit-tested in
isolation) turns raw operator input into `{ provider, key, url? }`. `url` is filled
only when resolvable **without** async work; the one case needing async (bare `#123`
→ repo base) is resolved once at set-time in the command layer (below), mirroring the
"capture once, store" principle of `prUrl` (never resolve at render/poll time).

Recognition order (first match wins), input trimmed:

| Input | Provider | `key` | `url` (derivation) |
|---|---|---|---|
| `https://linear.app/<ws>/issue/ENG-123[/…]` | linear | `ENG-123` | input URL as-is |
| `https://github.com/<owner>/<repo>/issues/<n>` | github | `<owner>/<repo>#<n>` | input URL as-is |
| `ENG-123` (`^[A-Z][A-Z0-9]+-\d+$`) | linear | `ENG-123` | from configured Linear workspace, else **none** |
| `owner/repo#123` (`^[\w.-]+/[\w.-]+#\d+$`) | github | `owner/repo#123` | `https://github.com/owner/repo/issues/123` |
| `#123` or `123` (`^#?\d+$`) | github | `#123` | from workspace repo `origin`, resolved at set-time |
| anything else | — | — | reject with a clear CLI error |

**Where the base URLs come from — knowable vs configured:**

- **GitHub `owner/repo` for bare `#123`:** *knowable.* Derive from the workspace
  repo's `origin` remote. Reuse the `gh`/`GhRunner` seam already established in
  `src/workspace/card-pr-url.ts` — add a sibling `resolveRepoNameWithOwner(cwd, run?)`
  that runs `gh repo view --json nameWithOwner` (falls back to parsing
  `git remote get-url origin`). Resolved once at set-time; if it fails, store `key`
  with no `url` (chip still shows, just isn't a link). Explicit `owner/repo#123` and
  full URLs need no lookup.
- **Linear workspace slug for bare `ENG-123`:** *not knowable* — Linear has no
  ref→URL resolver without the workspace slug. Make it **configured**: read
  `KANBAN_LINEAR_WORKSPACE` (the workspace url-slug, e.g. `acme`) from the
  environment at set-time and build `https://linear.app/<slug>/issue/ENG-123`. If
  unset, store the `ENG-123` key with no `url` (non-link chip). A full Linear URL
  always works regardless of config. Document the env var in the CLI help and
  `AGENTS.md`.

This keeps the parser pure and side-effect-free; only the command layer touches env
and `gh`, and only at set-time.

### CLI surface

One new option on both commands (following the `--agent-model` shape, incl. the
`default` → clear convention on update):

- `task create --external-issue <ref>` (alias `--issue <ref>`).
- `task update --external-issue <ref>` — `--external-issue default` clears it.

Unlike `--base-ref`/`--agent-model` (which are frozen once a card leaves backlog
because they drive the worktree, `task.ts:577-585`), `--external-issue` is pure
metadata and **editable in any column** — do not add the backlog-only guard. Wire it:
`createTask`/`updateTaskCommand` (`src/commands/task.ts:475,537`) call the parser +
set-time resolvers, pass a resolved `externalIssue` into `addTaskToColumn`'s input /
`updateTask`, and echo it in the JSON output (`task.ts:518-534`, `formatTaskRecord`).
Mutations plumbing mirrors `agentModel`: spread `...(externalIssue ? { externalIssue }
: {})` in `addTaskToColumn` (`task-board-mutations.ts:310-324`) and handle set/clear in
`updateTask`.

### Board display

Render in the **existing badge chip row** (`mt-1 flex min-w-0 items-center gap-1.5`,
`board-card.tsx`, the row introduced in `2eeeebb`), as the **leading chip** — an issue
ref is the card's most identifying cross-reference, so it reads first, before the
agent/model chip and completion-policy badge. It shows on cards in **every column**
(unlike the PR link, which is review/done-only and stays where it is).

- When `externalIssue.url` is set: an `<a>` chip (like the PR link) with
  `target="_blank" rel="noopener noreferrer"`, `onMouseDown`/`onClick`
  `stopPropagation` so clicking doesn't select/drag the card.
- When no `url`: a non-interactive `<span>` chip showing the key.
- Provider styling with a Lucide icon (14px): Linear → `status-purple` tint
  (`border-status-purple/30 bg-status-purple/10 text-status-purple`, matching the Plan
  badge); GitHub → neutral (`border-border bg-surface-1 text-text-tertiary`). Label =
  `externalIssue.key`. Keep it compact and truncate-safe (`min-w-0`, `truncate`).

Plumb the web model like `prUrl`: passthrough in `normalizeCard`
(`web-ui/src/state/board-state.ts`) and the `BoardCard` type + `ExternalIssue` type in
`web-ui/src/types/board.ts` (re-exporting the runtime types).

---

## Implementation outline — CHUNKY Codex cards

Three cards; each independently landable and typechecks/builds on its own. Cards 2 and
3 are independent of each other and both build on Card 1's types. Each carries a
`## Prior art` block citing `6e7d010` (prUrl end-to-end), `2eeeebb`/`44f4b86` (chip
rendering), and this doc.

### Card 1 — Core: schema, parser, resolvers, mutations *(foundation)*
- `src/core/api-contract.ts`: `runtimeExternalIssueProviderSchema`,
  `runtimeExternalIssueSchema`, optional `externalIssue` on the card schema.
- `src/core/external-issue.ts`: pure `parseExternalIssueRef(raw)` → `{ provider, key,
  url? }` per the table (no async, no env).
- `src/workspace/card-pr-url.ts` (or a sibling `src/workspace/repo-name.ts`):
  `resolveRepoNameWithOwner(cwd, run?)` reusing the `GhRunner` seam, for bare-`#123`
  github base resolution.
- `src/core/task-board-mutations.ts`: accept/persist `externalIssue` in
  `addTaskToColumn` input and in `updateTask` (set + clear), mirroring `agentModel`.
- Web model: `externalIssue` passthrough in `normalizeCard`
  (`web-ui/src/state/board-state.ts`) + types in `web-ui/src/types/board.ts`.
- Tests: parser table; schema back-compat (board.json without field parses; with field
  round-trips) — modeled on `test/runtime/core/card-pr-schema.test.ts`.

### Card 2 — CLI: `--external-issue` on create & update
- `src/commands/task.ts`: options on both commands (+ `default` clears on update),
  set-time resolution (parser + env `KANBAN_LINEAR_WORKSPACE` + repo-base resolver),
  thread through `createTask`/`updateTaskCommand`, echo in JSON output; **no**
  backlog-only guard. Help text documents the accepted forms and the Linear env var.
- Tests: create sets it; update sets/clears; update works outside backlog; each input
  form maps to the right `{provider,key,url}`; missing Linear config → key, no url.

### Card 3 — Web UI: the chip
- `web-ui/src/components/board-card.tsx`: leading chip in the `mt-1` badge row —
  deep-link when `url`, plain span otherwise, provider icon + styling, `stopPropagation`
  on click/mousedown.
- Tests (`board-card.test.tsx`, modeled on the `prUrl` cases): renders key; is a link
  with correct `href`/`target`/`rel` when `url` present; is a plain chip when absent;
  provider styling; click doesn't select the card.

---

## Test strategy (RED-first for `/implement`)

- **Unit — parser** (`external-issue.test.ts`): exhaustive input→output table incl.
  the reject case. Pure, fast, no mocks.
- **Unit — schema back-compat** (`card-external-issue-schema.test.ts`): a legacy
  board.json parses with `externalIssue` undefined; a card with the field round-trips
  through `runtimeBoardCardSchema`.
- **Unit — repo-base resolver**: mock `GhRunner`; `nameWithOwner` happy path + failure
  → `null` (chip still renders keyless-of-url).
- **Component** (`board-card.test.tsx`): link vs plain chip, provider styling,
  `stopPropagation`.
- **CLI**: create/update set & clear; update-outside-backlog allowed; each ref form.

No BDD/surface suite exists for this area; component + CLI tests are the user-facing
surface here.

---

## Risks, open questions, out of scope

- **Linear workspace config.** Bare `ENG-123` links depend on `KANBAN_LINEAR_WORKSPACE`.
  Acceptable: without it the chip still shows the key (just not clickable), and full
  Linear URLs always link. *Open:* env var vs a workspace-level setting — env keeps
  Card 2 self-contained; a settings-backed value can follow later.
- **No validation that the issue exists.** We store what the operator typed (`raw`
  preserved); we don't call Linear/GitHub to confirm the issue is real. Intentional —
  keeps set-time cheap and offline-friendly.
- **One issue per card.** The field holds a single ref. Many-cards-per-issue is
  supported; one-card-many-issues is out of scope (YAGNI; revisit if needed).
- **Out of scope:** two-way sync (updating Linear/GitHub from the board), status
  mirroring, auto-detecting an issue from branch/commit text, and GitHub *PR* refs
  (already covered by `prUrl`). This card only records and links *out*.
