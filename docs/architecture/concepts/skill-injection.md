# Skill injection & directives

**Importance:** medium  ·  **Lives in:** `src/prompts/compose-card-directive.ts`, `src/prompts/append-system-prompt.ts`, `src/workspace/task-worktree.ts`, `.agents/skills/*/SKILL.md`

The mechanism that makes agent skills available in each worktree and composes their prompt directives from the skill frontmatter.

## Domain model
On worktree creation, the canonical `.agents/skills` dir is symlinked into the worktree so agents load
skill bodies natively. Rather than using hardcoded TS directive functions, the runtime extracts prompt
directives dynamically from the `directive:` YAML frontmatter field of active skills inside the canonical
skills directory. Placeholders (such as `${baseRef}`) are interpolated, and the directives are concatenated in
declared phase order. This ensures the prompt-directive channel and native skill-body channel never drift.

## Reuse / do-not-duplicate
- Relates to [Worktree](worktree.md), [Auto-review / PR mode](auto-review-pr-mode.md),
  [Home / architect agent session](home-agent-session.md), [Card type / skill pipeline](card-types.md).
- **Do not duplicate:** directives guide the agent on how to use the skill — put actual tool and implementation execution details in the skill body, not the directive string.
