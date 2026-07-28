# Card Type & Skill Pipeline

**Importance:** high  ·  **Lives in:** `src/core/card-type.ts`, `src/prompts/card-type-discovery.ts`, `src/prompts/compose-card-directive.ts`, `src/trpc/runtime-api.ts`, `fleet-cli/fleet`, `fleet/card-types/`, `fleet/skills/`

A data-defined workflow mapping operational phases to Kanban board lanes, and dynamically composing AI agent skills and system directives at session start. Custom card types live at `fleet/card-types/`, and custom skills live in a parallel project layer at `fleet/skills/`.

## Domain model
A card type is represented as a markdown file with YAML frontmatter containing an ordered list of `phases`. Each phase maps to a specific board lane (`backlog`, `in_progress`, `review`, `done`), binds an ordered list of `skills`, specifies an `activation` condition (`default`, `plan-flag`, `auto-review-pr`, `dormant`), and optionally defines `planMode` (to force a real agent plan mode launch).

At session start, the card's current lane is matched against the card type's phases, active phases are computed using active CLI sugar flags, and the ordered list of skills is compiled. System directives are single-sourced and extracted from each skill's `SKILL.md` frontmatter `directive:` field and concatenated centrally.

## Reuse / do-not-duplicate
- Relates to [Task card](task-card.md), [Card lifecycle](card-lifecycle.md), [Skill injection](skill-injection.md), [Auto-review](auto-review-pr-mode.md).
- **Do not duplicate:** Directives are derived exclusively from skill frontmatter; do not define separate hardcoded directive files or hardcoded prompt builders for lanes.
