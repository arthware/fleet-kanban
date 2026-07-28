# Skill injection & directives

**Importance:** medium  ·  **Lives in:** `src/prompts/compose-card-directive.ts`, `src/prompts/append-system-prompt.ts`, `src/workspace/task-worktree.ts`, `src/prompts/skill-discovery.ts`, `.agents/skills/*/SKILL.md`, `fleet/skills/*/SKILL.md`

The mechanism that makes agent skills available in each worktree and composes their prompt directives from the skill frontmatter.

## Domain model
Skills resolve through **two layers** under a single shared resolver (`src/prompts/skill-discovery.ts`):

1. **Project Layer (`project`):** Custom project-level skills reside in the repository at `<workspacePath>/fleet/skills/<name>/SKILL.md`.
2. **Bundled Layer (`bundled`):** Default built-in skills reside in the package installation's `.agents/skills/<name>/SKILL.md` directory.

### Layered Resolution Order
The resolver scans layers sequentially: **Project Layer first, then Bundled Layer**. The first matching layer containing a valid `SKILL.md` wins and resolves that skill. Consequently, a same-named project skill at `fleet/skills/<name>` shadows the built-in bundled skill of the same name.

This exact same resolver serves both key channels:
- **The directive channel** (e.g. `composeCardDirective`, `validateSkill`): reads resolved skill frontmatter to extract system directives.
- **The worktree body channel** (e.g. `ensureWorktreeSkillsDirectory`): mounts resolved skill files into the task worktree.

Using a single shared resolver guarantees that the prompt-directive channel and the native skill-body channel never drift or go out of sync.

### Merged Worktree Mount
On task worktree creation, the skills directory inside the worktree (typically `<worktreePath>/.agents/skills`) is mounted as a **merged directory** rather than a single directory-level symlink:

1. The runtime creates the target directory inside the worktree if it does not exist.
2. For every unique resolved skill across both layers (with project-layer shadowing applied), the runtime creates a dedicated directory-level symbolic link pointing directly to that skill's resolved source directory.

This merged mount prevents a repository that has custom skills at `fleet/skills/` from losing access to default bundled skills. All available skills are seamlessly aggregated.

### Prompt Directives
The runtime extracts prompt directives dynamically from the `directive:` YAML frontmatter field of resolved active skills. Placeholders (such as `${baseRef}`) are interpolated, and the directives are concatenated in the declared phase order.

## Reuse / do-not-duplicate
- Relates to [Worktree](worktree.md), [Auto-review / PR mode](auto-review-pr-mode.md),
  [Home / architect agent session](home-agent-session.md), [Card type / skill pipeline](card-types.md).
- **Do not duplicate:** directives guide the agent on how to use the skill — put actual tool and implementation execution details in the skill body, not the directive string.
