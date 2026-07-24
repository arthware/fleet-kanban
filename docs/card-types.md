# Card Types & Skill Pipelines

**Card types** are data-defined, modular workflows that govern how task cards behave across different board lanes. A card type binds ordered operational phases to Kanban board lanes, dynamically composing the required AI agent skills and instruction directives at session start.

Skill bodies and prompt directives are unified under a single source of truth: the skill files themselves.

---

## 1. Core Concepts & Architecture

### 1.1 The Card-Type Model
A Kanban card represents a durable unit of work, while an AI agent session represents ephemeral compute. At session launch or restart, the runtime dynamically derives the proper system instructions and execution mode from the card's current lane, its card type (defaulting to `feature`), and any active flags.

```
[Card Type (feature)] ────▶ [Current Lane (in_progress)]
                                  │
                                  ▼
                        [Active Phase (build)]
                                  │
                       ┌──────────┴──────────┐
                       ▼                     ▼
             [Skill: fleet-implement]   [planMode: false]
                       │
                       ▼
             [Read SKILL.md Frontmatter]
                       │
                       ▼
             [Compose Prompt Directive]
```

### 1.2 Unified Central Injection (Single Source of Truth)
System directives are compiled and injected centrally:
1. **Skill-Derived Directives**: Directives are extracted from the `directive:` YAML frontmatter field of active skill files (e.g., `.agents/skills/fleet-implement/SKILL.md`).
2. **Deterministic Composition**: At session start, the active phase's skills are resolved, and their frontmatter directives are loaded from the canonical skills directory. Placeholders (such as `${baseRef}` in the `fleet-pr` directive) are dynamically interpolated, and the resulting prompt strings are concatenated in declared order.
3. **Unified Plan Mode Execution**: If any active phase has `planMode: true`, the session launches in real agent plan mode centrally, and adapters simply receive this unified start configuration.

---

## 2. Card-Type Manifest Schema

Card type manifests are stored as Markdown files with YAML frontmatter at `fleet/card-types/<name>.md`. 

### 2.1 Frontmatter Schema
The manifest frontmatter is parsed with `gray-matter` and validated against a strict Zod schema (`src/core/card-type.ts`):

```yaml
name: string                # Unique card type ID (must match the filename stem)
description: string         # Single-line description shown in `fleet card-type ls`
phases:                     # Ordered list of phases; composition order within a lane
  - name: string            # Phase ID (e.g., design, build, ship, verify)
    lane: string            # Kanban lane mapping: backlog | in_progress | review | done
    skills: [string, ...]   # Ordered skill names pointing to `.agents/skills/<name>`
    activation: string      # Activation rule: default | plan-flag | auto-review-pr | dormant
    planMode?: boolean      # Optional; if true, the agent launches in real plan mode
```

### 2.2 Phase Activation Rules
The `activation` property determines if a phase is active for a given card session. This mapping allows existing CLI flags to act as clean, backward-compatible "sugar" over the underlying data model:

| `activation` | Phase is active if and only if | Corresponding CLI Flag |
| :--- | :--- | :--- |
| `default` | Always active | None (base workflow) |
| `plan-flag` | `card.startInPlanMode === true` | `fleet task create --plan` |
| `auto-review-pr` | `card.autoReviewEnabled === true && card.autoReviewMode === "pr"` | `fleet task create --auto-review pr` |
| `dormant` | Never active in v1 (reserved for future orchestration) | None |

---

## 3. The Built-in `feature` Manifest

Every card defaults to the built-in `feature` card type if no explicit type is provided. This type preserves existing system behavior with absolute, byte-identical precision.

The built-in manifest lives at `fleet/card-types/feature.md`:

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

### 3.1 Resolution Examples (The `feature` Type)

| Starting Lane | Active Flags | Resolved Phase(s) | Composed Skills | Resulting Behavior |
| :--- | :--- | :--- | :--- | :--- |
| `in_progress` | (None) | `build` | `[fleet-implement]` | Standard implementation session |
| `backlog` | `--plan` | `design` | `[fleet-plan]` | Enters plan-mode session using the design directive |
| `in_progress` | `--auto-review pr` | `build`, `ship` | `[fleet-implement, fleet-pr]` | Stacks implementation directive followed by PR-submission directive |
| `review` | (None) | (None) | `[]` | Phase `verify` is dormant; no session starts on entering Review |

---

## 4. How to Use Card Types

The `fleet` CLI provides first-class commands to discover, inspect, author, and remove card types.

### 4.1 Listing and Inspecting Card Types
To view available card types across your project and built-in fallbacks:

```bash
# List all card types and their descriptions
fleet card-type ls

# Output:
# card-types — workflows defining phases and skills (run: fleet card-type show <name>)
#   feature              The default card workflow — design → build → ship, with a dormant verify lane.
```

To display the complete raw manifest file of a specific card type:

```bash
# Show a card type
fleet card-type show feature

# Get the on-disk file path for a card type
fleet card-type path feature
```

### 4.2 Creating a Custom Card Type
To scaffold a new custom card type manifest in your project's local `fleet/card-types/` directory:

```bash
fleet card-type new bugfix
# Output: created /path/to/project/fleet/card-types/bugfix.md
```

This creates a default template containing basic phase definitions. You can open and edit this file in your editor:

```bash
fleet card-type edit bugfix
```

### 4.3 Deleting a Custom Card Type
To remove a project-level custom card type:

```bash
fleet card-type rm bugfix
```
*Note: Built-in card types (like `feature`) are protected and cannot be removed via this command.*

### 4.4 Using a Card Type on a Card
You can assign a card type when creating a card in one of three ways:

1. **Using the CLI flag**:
   ```bash
   fleet task create --type bugfix "Fix race condition in session router"
   ```
2. **Using the Kanban CLI directly**:
   ```bash
   task create --card-type bugfix "Fix race condition in session router"
   ```
3. **Using Markdown Frontmatter**: Add the `card-type` (or `cardType`) key in the YAML frontmatter of your card file:
   ```markdown
   ---
   title: Fix race condition in session router
   card-type: bugfix
   ---

   Investigate and fix the race condition inside the session manager router.
   ```

---

## 5. Worked Example: Implementing a Custom `bugfix` Workflow

Let's say we want a dedicated workflow for bug fixes. Instead of writing full feature plans or shipping PRs automatically, we want bugfix tasks to run a quick regression check using a `regression-test` skill in the `backlog` lane, and then proceed with standard build-and-verify in `in_progress`.

### Step 1: Scaffold the Card Type
Run the CLI command to create the manifest:

```bash
fleet card-type new bugfix
```

### Step 2: Edit the Manifest
Edit `fleet/card-types/bugfix.md` so that it uses a lightweight pipeline:

```yaml
---
name: bugfix
description: Specialized workflow for rapid bug fixing and automated regression checking.
phases:
  - name: test-repro
    lane: backlog
    skills: [fleet-smoke]
    activation: default
  - name: build
    lane: in_progress
    skills: [fleet-implement]
    activation: default
---

# bugfix

A specialized workflow that runs `fleet-smoke` tests in the backlog lane before allowing
developers to start implementing the fix under the standard `fleet-implement` skill.
```

### Step 3: Create a task using the `bugfix` card type
Create the card:

```bash
fleet task create --type bugfix "Fix websocket ping timeout"
```

### Step 4: Run the Card
- While the card is in **`backlog`**: starting a session will activate the `test-repro` phase, injecting only the `fleet-smoke` skill and its associated directive.
- Once you move the card to **`in_progress`**: starting a session will activate the `build` phase, seamlessly switching to the `fleet-implement` skill and directive.

By dropping a single markdown manifest, you have customized your entire AI-agent task pipeline without writing or modifying a single line of application source code.
