**Architecture docs — read before grepping:**
- `docs/architecture/constitution.md` — the **non-negotiable core** (the law). Reuse-before-rebuild,
  root-cause-not-duct-tape, module-tests, verification-before-completion. This file holds the working
  knowledge; the constitution holds the principles — defer to it, don't restate it here.
- `docs/architecture/concepts/` — the **concept map**: core domain concepts, each with its one
  canonical home. Consult it before introducing anything (Constitution Article 1) so you extend what
  exists instead of re-inventing a near-duplicate.
- `docs/architecture/component-overview.md` — *which file to edit* for a given task (component map +
  "to change X, edit Y" index + gotchas). Start here instead of searching the whole tree.
- `docs/architecture.md` — the *conceptual* map (mental model, ownership, design rules, main flows).

**Don't research from zero.** If you're an impl agent working a card, do NOT launch broad
codebase-discovery sub-agents to re-learn the tree. Your prompt should already point at the relevant
change-index reference (prior work: which commit/files touched this area) and the `to change X, edit
Y` map in `component-overview.md` — start there and read those files directly. Only escalate to wider
exploration when that primed context genuinely doesn't cover what you need, and when you do, say so
(what was missing) so the next card's prompt can be primed better. Broad Opus-driven sweeps on every
card are the cost spiral we're closing, not the default.

**Prior-art commits — cite them, then read them first.** A card may carry an optional, well-known
`## Prior art` section that names the commit(s) of similar past work. It is the manual, per-card
precursor to the automated change-index (see `docs/design/architect-console.md` §6) — until that
ledger exists, the operator hand-cites the SHAs. The shape is exactly:

```
## Prior art (read with `git show <sha>` before starting)
- <sha> — <one line: what it did / why it's similar>
```

It is **optional** — most cards won't have it, and you never add it to fill space. But **when a card
does list Prior art, treat it as a required first step: before writing any code, run `git show <sha>`
(and `git log -p -1 <sha>` for the fuller diff) on each cited commit and match the pattern it
established.** Reading the actual prior diff is cheaper and more consistent than re-deriving the tree,
and it is the primed-context path that replaces a broad codebase sweep.

---

This file captures tribal knowledge-the nuanced, non-obvious patterns that make the difference between a quick fix and hours of debugging.
When to add to this file:
- User had to intervene, correct, or hand-hold
- Multiple back-and-forth attempts were needed to get something working
- You discovered something that required reading many files to understand
- A change touched files you wouldn't have guessed
- Something worked differently than you expected
- User explicitly asks to add something
Proactively suggest additions when any of the above happen-don't wait to be asked.
What NOT to add: Stuff you can figure out from reading a few files, obvious patterns, or standard practices. This file should be high-signal, not comprehensive.

---

TypeScript principles
- No any types unless absolutely necessary.
- Check node_modules for external API type definitions instead of guessing.
- Prefer SDK-provided types, schemas, helpers, and model metadata over local redefinitions. For things like Cline SDK reasoning settings, use the SDK's source of truth whenever possible instead of recreating unions, support checks, or shapes in Kanban.
- NEVER use inline imports. No await import("./foo.js"), no import("pkg").Type in type positions, and no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies. Upgrade the dependency instead.

Code quality
- Write production-quality code, not prototypes
- Break components into small, single-responsibility files. 
- Extract shared logic into hooks and utilities. 
- Prioritize maintainability and clean architecture over speed. 
- Follow DRY principles and maintain clean architecture with clear separation of concerns.
- In `web-ui`, prefer `react-use` hooks (via `@/kanban/utils/react-use`) whenever possible
- Before adding custom utility code, evaluate whether a well-maintained third-party package can reduce complexity and long-term maintenance cost.

Architecture opinions
- Avoid thin shell wrappers that only forward props or relocate JSX for a single call site.
- Prefer extracting domain logic (state, effects, async orchestration) over presentation-only pass-through layers.
- Do not optimize for line count alone. Optimize for codebase navigability and clarity.

Git guardrails
- NEVER commit unless user asks.

GitHub issues
When reading issues:
- Always read all comments on the issue.
- Use this command to get everything in one call:
  gh issue view <number> --json title,body,comments,labels,state

When closing issues via commit:
- Include fixes #<number> or closes #<number> in the commit message. This automatically closes the issue when the commit is merged.

web-ui Stack
- Kanban web-ui uses Tailwind CSS v4 for styling, Radix UI for accessible headless primitives, and Lucide React for icons.
- Custom UI primitives live in `src/components/ui/` (button, dialog, tooltip, kbd, spinner, cn utility).
- Toast notifications use `sonner`. Import `{ toast }` from `"sonner"` or use `showAppToast` from `@/components/app-toaster`.

Styling mental model
- Use Tailwind utility classes as the primary styling system. Prefer `className` over inline `style={{}}`.
- Prefer Tailwind classes over adding custom CSS in `globals.css` when possible. Conditional Tailwind classes via `cn()` are better than CSS overrides for state-driven styling (e.g. selected/active variants). Reserve `globals.css` for things Tailwind can't express: complex selectors (sibling combinators, attribute selectors), app-level layout glue, or styles that genuinely need to cascade.
- Only use inline `style={{}}` for truly dynamic values (colors from props/variables, computed positions from drag-and-drop, runtime-dependent dimensions).
- The design system tokens are defined in `globals.css` inside `@theme { ... }`. Use Tailwind utilities that reference them: `bg-surface-0`, `text-text-primary`, `border-border`, etc.

Design tokens (defined in globals.css @theme)
- Surface hierarchy: `surface-0` (#1F2428, app bg / columns), `surface-1` (#24292E, navbar / project col / raised), `surface-2` (#2D3339, cards/inputs), `surface-3` (#353C43, hover), `surface-4` (#3E464E, pressed/scrollbars)
- Borders: `border` (#30363D, default), `border-bright` (#444C56, more visible), `border-focus` (#0084FF, focus rings)
- Text: `text-primary` (#E6EDF3), `text-secondary` (#8B949E), `text-tertiary` (#6E7681)
- Accent: `accent` (#0084FF), `accent-hover` (#339DFF)
- Status: `status-blue` (#4C9AFF), `status-green` (#3FB950), `status-orange` (#D29922), `status-red` (#F85149), `status-purple` (#A371F7), `status-gold` (#D4A72C)
- Border radius: `rounded-sm` (4px), `rounded-md` (6px), `rounded-lg` (8px), `rounded-xl` (12px)

UI primitives (src/components/ui/)
- `Button` from `@/components/ui/button`: `variant="default"|"primary"|"danger"|"ghost"`, `size="sm"|"md"`, `icon={<LucideIcon />}`, `fill`, children for text content.
- `Dialog`, `DialogHeader`, `DialogBody`, `DialogFooter` from `@/components/ui/dialog`: For modals. `DialogHeader` takes a `title` string.
- `AlertDialog`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel` from `@/components/ui/dialog`: For destructive confirmations.
- `Tooltip` from `@/components/ui/tooltip`: `<Tooltip content="text"><trigger/></Tooltip>`.
- `Spinner` from `@/components/ui/spinner`: `size` (number), `className`.
- `Kbd` from `@/components/ui/kbd`: Keyboard shortcut display.
- `cn` from `@/components/ui/cn`: Utility for conditional className joining.

Icons
- Use `lucide-react` for all icons. Import individual icons: `import { Settings, Plus, Play } from "lucide-react"`.
- Standard icon sizes: 14px for small buttons, 16px for default contexts.
- Pass icons as JSX elements to button `icon` prop: `icon={<Settings size={16} />}`.

Radix UI primitives
- Use Radix directly for headless behavior: `@radix-ui/react-popover`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-checkbox`, `@radix-ui/react-switch`, `@radix-ui/react-collapsible`, `@radix-ui/react-select`.
- Style Radix components with Tailwind classes. Use `data-[state=checked]:` for state-driven styling.

Dark theme
- The app is always in dark theme. Colors are set via CSS custom properties in `globals.css`.
- Surface hierarchy: `bg-surface-0` (app background) -> `bg-surface-1` (raised panels) -> `bg-surface-2` (cards/inputs) -> `bg-surface-3` (hover) -> `bg-surface-4` (pressed).
- Do NOT use Blueprint, Tailwind's light-mode defaults, or any `dark:` prefix. The theme is always dark.

Misc. tribal knowledge
- Kanban's native Cline agent is powered by the installed `@clinebot/core` and `@clinebot/llms` packages plus the local `src/cline-sdk/` boundary layer, so when Cline behavior is unclear, inspect those packages and `src/cline-sdk/` for the real implementation details.
- Kanban is launched from the user's shell and inherits its environment. For agent detection and task-agent startup, prefer direct PATH checks and direct process launches over spawning an interactive shell. Avoid `zsh -i`, shell fallback command discovery, or "launch shell then type command into it" on hot paths. On setups with heavy shell init like `conda` or `nvm`, doing that per task can freeze the runtime and even make new Terminal.app windows feel hung when several tasks start at once. It's fine to use an actual interactive shell for explicit shell terminals, not for normal agent session work.
- `task create/update --external-issue` stores one optional Linear/GitHub issue ref on a card. Bare Linear keys like `ENG-123` only become links when `KANBAN_LINEAR_WORKSPACE` is set to the Linear workspace URL slug; otherwise the chip intentionally shows the key without a link.
- A repo's `.cline/kanban/config.json` can carry `worktree.postCreateCommand`, an auto-running command executed once after Kanban creates a new task worktree; review changes to that file like executable project config.
- If CI hangs on Node 22 after tests seem to finish, suspect a live subprocess or SDK-host startup path before assuming a slow test body. Read `.plan/docs/node22-ci-hanging-tests-investigation.md` before repeating that investigation. `test/runtime/cline-sdk/cline-task-session-service.test.ts` was the big prior culprit because a unit-style suite was still booting the real Cline SDK host.
- When Kanban runs on a headless remote Linux instance (for example over SSH+tunnel), native folder picker commands may be unavailable (`zenity`/`kdialog`). Treat this as a normal remote-runtime limitation and use manual path entry fallback instead of requiring desktop packages.

Testing scope & running (match the gate to what you changed — don't burn tokens on ceremony)
- **Scope the verify gate to the change surface.** For a CLI/runtime-only change (`src/commands/*`, `src/cli.ts`, `src/**` non-web), the gate is `npm run typecheck` + `npm run test:fast` (the pre-commit tier = `vitest run test/runtime test/utilities`) + the specific test files your diff touches (`npx vitest run <file>`). For a web-ui change, use `npm --prefix web-ui run typecheck` + targeted `web:test` files. **Never run the full `npm run build` on the inner loop** — it bundles the entire web app (vite, ~2MB) + sentry and is pure waste for a CLI change; if you need the built `dist/cli.js` to smoke-test, build only the CLI with `node scripts/build.mjs` (skips `web:build`).
- **Never gate on repo-root `npx vitest run` (or `test:integration`).** Root `vitest run` sweeps in `test/integration/*` server-boot tests that **time out in agent worktrees** and produce phantom failures you then waste time ruling out. Those are a CI concern, not your loop.
- **CLI-entry warning/bootstrap logic must be unit-testable without the entry.** Extract helpers (e.g. the DEP-warning filter) into a **non-entry module**; **never import `src/cli.ts` in a unit test** — importing the entry drags in the whole bootstrap.
- **`test/integration/task-command-exit.integration.test.ts` runs sequentially**, not in parallel with `test:fast`.
- **`vitest.integration.config.ts` has global setup.** For an isolated source-CLI file run use the **base** vitest config, not the integration config, unless you actually intend the whole integration setup.
- **Format before committing.** The pre-commit biome hook rejects unformatted code (e.g. multi-line JSX prop splits) — run the formatter first so you don't eat a reject-and-recommit round-trip.
