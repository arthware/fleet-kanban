import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import matter from "gray-matter";
import { describe, expect, it, vi } from "vitest";

import { CLAUDE_SKILLS_RELATIVE_PATH } from "../../src/agents/claude/paths";
import {
	ensureWorktreeSkillsDirectory,
	mirrorIgnoredPath,
	resolveCanonicalSkillsDir,
	resolveWorktreeSkillsRelativePath,
} from "../../src/workspace/task-worktree";

function createErrnoError(code: string): NodeJS.ErrnoException {
	const error = new Error(code) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("mirrorIgnoredPath", () => {
	it("mirrors successfully when symlink succeeds", async () => {
		const createSymlink = vi.fn(async () => {});
		await expect(
			mirrorIgnoredPath({
				sourcePath: "/source",
				targetPath: "/target",
				isDirectory: true,
				createSymlink,
			}),
		).resolves.toBe("mirrored");
	});

	it("skips mirroring when symlink fails with EPERM", async () => {
		const createSymlink = vi.fn(async () => {
			throw createErrnoError("EPERM");
		});

		await expect(
			mirrorIgnoredPath({
				sourcePath: "/source",
				targetPath: "/target",
				isDirectory: true,
				createSymlink,
			}),
		).resolves.toBe("skipped");
	});

	it("skips mirroring when symlink fails with non-errno errors", async () => {
		const createSymlink = vi.fn(async () => {
			throw new Error("unexpected");
		});

		await expect(
			mirrorIgnoredPath({
				sourcePath: "/source",
				targetPath: "/target",
				isDirectory: true,
				createSymlink,
			}),
		).resolves.toBe("skipped");
	});

	it("skips mirroring when symlink fails with EIO", async () => {
		const createSymlink = vi.fn(async () => {
			throw createErrnoError("EIO");
		});

		await expect(
			mirrorIgnoredPath({
				sourcePath: "/source",
				targetPath: "/target",
				isDirectory: true,
				createSymlink,
			}),
		).resolves.toBe("skipped");
	});
});

describe("worktree skills directory placement", () => {
	async function createSandbox(): Promise<{ root: string; cleanup: () => void }> {
		const root = await mkdtemp(join(tmpdir(), "kanban-worktree-skills-"));
		return {
			root,
			cleanup: () => {
				rmSync(root, { recursive: true, force: true });
			},
		};
	}

	it("given a fresh worktree is created, when setup runs, then bundled skills are linked inside .agents/skills", async () => {
		const { root, cleanup } = await createSandbox();
		try {
			const canonicalSkillsDir = join(root, "board", ".agents", "skills");
			const canonicalSkillDir = join(canonicalSkillsDir, "fleet-smoke");
			const worktreePath = join(root, "worktree");
			mkdirSync(canonicalSkillDir, { recursive: true });
			writeFileSync(join(canonicalSkillDir, "SKILL.md"), "---\nname: fleet-smoke\ndirective: smoke\n---\n", "utf8");
			mkdirSync(worktreePath, { recursive: true });

			const result = await ensureWorktreeSkillsDirectory({
				worktreePath,
				canonicalSkillsDir,
			});

			expect(result).toBe("linked");
			expect(lstatSync(join(worktreePath, ".agents", "skills")).isDirectory()).toBe(true);
			expect(realpathSync(join(worktreePath, ".agents", "skills", "fleet-smoke"))).toBe(
				realpathSync(canonicalSkillDir),
			);
		} finally {
			cleanup();
		}
	});

	it("exposes fleet-plan through the same canonical skills injection path as fleet-smoke", async () => {
		const { root, cleanup } = await createSandbox();
		try {
			const canonicalSkillsDir = await resolveCanonicalSkillsDir();
			expect(canonicalSkillsDir).toBeTruthy();
			const worktreePath = join(root, "worktree");
			mkdirSync(worktreePath, { recursive: true });

			const result = await ensureWorktreeSkillsDirectory({
				worktreePath,
				canonicalSkillsDir,
			});

			expect(result).toBe("linked");
			for (const skillName of ["fleet-smoke", "fleet-plan", "fleet-pr"]) {
				const skill = matter(readFileSync(join(worktreePath, ".agents", "skills", skillName, "SKILL.md"), "utf8"));
				expect(skill.data.name).toBe(skillName);
				expect(typeof skill.data.description).toBe("string");
				expect(skill.data.description).not.toBe("");
			}
		} finally {
			cleanup();
		}
	});

	it("given a worktree that already has its own .agents/skills, when setup runs, then it is not clobbered", async () => {
		const { root, cleanup } = await createSandbox();
		try {
			const canonicalSkillsDir = join(root, "board", ".agents", "skills");
			const worktreeSkillsDir = join(root, "worktree", ".agents", "skills");
			mkdirSync(canonicalSkillsDir, { recursive: true });
			mkdirSync(worktreeSkillsDir, { recursive: true });
			writeFileSync(join(worktreeSkillsDir, "owned.txt"), "project-owned\n", "utf8");

			const result = await ensureWorktreeSkillsDirectory({
				worktreePath: join(root, "worktree"),
				canonicalSkillsDir,
			});

			expect(result).toBe("existing");
			expect(lstatSync(worktreeSkillsDir).isDirectory()).toBe(true);
			expect(readFileSync(join(worktreeSkillsDir, "owned.txt"), "utf8")).toBe("project-owned\n");
			expect(realpathSync(worktreeSkillsDir)).not.toBe(realpathSync(canonicalSkillsDir));
		} finally {
			cleanup();
		}
	});

	it("given project and bundled skills with the same name, when setup runs, then the project body wins in the merged mount", async () => {
		const { root, cleanup } = await createSandbox();
		try {
			const workspacePath = join(root, "repo");
			const projectSkillDir = join(workspacePath, "fleet", "skills", "fleet-pr");
			const canonicalSkillsDir = join(root, "board", ".agents", "skills");
			const bundledSkillDir = join(canonicalSkillsDir, "fleet-pr");
			const bundledOnlySkillDir = join(canonicalSkillsDir, "fleet-implement");
			const worktreePath = join(root, "worktree");
			mkdirSync(projectSkillDir, { recursive: true });
			mkdirSync(bundledSkillDir, { recursive: true });
			mkdirSync(bundledOnlySkillDir, { recursive: true });
			mkdirSync(worktreePath, { recursive: true });
			writeFileSync(
				join(projectSkillDir, "SKILL.md"),
				"---\nname: fleet-pr\ndirective: project\n---\nProject body\n",
				"utf8",
			);
			writeFileSync(
				join(bundledSkillDir, "SKILL.md"),
				"---\nname: fleet-pr\ndirective: bundled\n---\nBundled body\n",
				"utf8",
			);
			writeFileSync(
				join(bundledOnlySkillDir, "SKILL.md"),
				"---\nname: fleet-implement\ndirective: bundled implement\n---\n",
				"utf8",
			);

			const result = await ensureWorktreeSkillsDirectory({
				worktreePath,
				workspacePath,
				canonicalSkillsDir,
			});

			expect(result).toBe("linked");
			expect(realpathSync(join(worktreePath, ".agents", "skills", "fleet-pr"))).toBe(realpathSync(projectSkillDir));
			expect(realpathSync(join(worktreePath, ".agents", "skills", "fleet-implement"))).toBe(
				realpathSync(bundledOnlySkillDir),
			);
			expect(readFileSync(join(worktreePath, ".agents", "skills", "fleet-pr", "SKILL.md"), "utf8")).toContain(
				"Project body",
			);
		} finally {
			cleanup();
		}
	});

	it("given the canonical skills dir cannot be resolved, when setup runs, then no skills link is created and no throw occurs", async () => {
		const { root, cleanup } = await createSandbox();
		try {
			const worktreePath = join(root, "worktree");
			mkdirSync(worktreePath, { recursive: true });

			const result = await ensureWorktreeSkillsDirectory({
				worktreePath,
				resolveCanonicalSkillsDir: async () => null,
			});

			expect(result).toBe("missing_canonical");
			await expect(
				resolveCanonicalSkillsDir({
					moduleDir: join(root, "legacy-build"),
					pathExists: async () => false,
				}),
			).resolves.toBeNull();
		} finally {
			cleanup();
		}
	});

	it("given a claude agent, when skills are placed at the Claude skills relative path, then bundled skill links are created there", async () => {
		const { root, cleanup } = await createSandbox();
		try {
			const canonicalSkillsDir = join(root, "board", ".agents", "skills");
			const canonicalSkillDir = join(canonicalSkillsDir, "fleet-smoke");
			const worktreePath = join(root, "worktree");
			mkdirSync(canonicalSkillDir, { recursive: true });
			writeFileSync(join(canonicalSkillDir, "SKILL.md"), "---\nname: fleet-smoke\ndirective: smoke\n---\n", "utf8");
			mkdirSync(worktreePath, { recursive: true });

			const result = await ensureWorktreeSkillsDirectory({
				worktreePath,
				skillsRelativePath: resolveWorktreeSkillsRelativePath("claude"),
				canonicalSkillsDir,
			});

			expect(result).toBe("linked");
			expect(realpathSync(join(worktreePath, CLAUDE_SKILLS_RELATIVE_PATH, "fleet-smoke"))).toBe(
				realpathSync(canonicalSkillDir),
			);
			// The codex/default location is NOT created for a claude card.
			expect(() => lstatSync(join(worktreePath, ".agents", "skills"))).toThrow();
		} finally {
			cleanup();
		}
	});
});

describe("resolveWorktreeSkillsRelativePath", () => {
	it("maps the claude agent to the Claude skills relative path", () => {
		expect(resolveWorktreeSkillsRelativePath("claude")).toBe(CLAUDE_SKILLS_RELATIVE_PATH);
	});

	it("keeps codex and other agents on .agents/skills", () => {
		expect(resolveWorktreeSkillsRelativePath("codex")).toBe(".agents/skills");
		expect(resolveWorktreeSkillsRelativePath("gemini")).toBe(".agents/skills");
	});

	it("falls back to .agents/skills for an unset agent", () => {
		expect(resolveWorktreeSkillsRelativePath()).toBe(".agents/skills");
		expect(resolveWorktreeSkillsRelativePath(null)).toBe(".agents/skills");
	});
});
