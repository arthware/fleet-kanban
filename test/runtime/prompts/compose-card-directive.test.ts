import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, describe, expect, it } from "vitest";
import { composeCardDirective } from "../../../src/prompts/compose-card-directive";
import { resolveSkillSync } from "../../../src/prompts/skill-discovery";

/**
 * The `directive:` a bundled skill declares in its own SKILL.md frontmatter.
 *
 * These tests deliberately do NOT keep a copy of that prose. A duplicate here would
 * break on every intentional wording change while proving nothing about
 * `composeCardDirective` — it would only assert that nobody edited a skill file.
 * What the composer actually promises is that the directive is *single-sourced from
 * the skill*, so that is what we read and assert against.
 */
function declaredDirective(skillName: string): string {
	const resolved = resolveSkillSync(skillName, {});
	if (!resolved) {
		throw new Error(`Expected bundled skill "${skillName}" to resolve.`);
	}
	const { data } = matter(readFileSync(resolved.skillFilePath, "utf-8"));
	if (typeof data.directive !== "string" || data.directive.trim() === "") {
		throw new Error(`Expected bundled skill "${skillName}" to declare a directive.`);
	}
	return data.directive;
}

describe("composeCardDirective", () => {
	const tempDirs: string[] = [];

	function createTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	function writeSkill(root: string, skillName: string, directive: string): void {
		const skillDir = join(root, skillName);
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: ${skillName}
directive: "${directive}"
---

Body for ${skillName}
`,
			"utf8",
		);
	}

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs.length = 0;
	});

	it("given a build card skill (fleet-implement), when composed, then it is sourced verbatim from that skill's own frontmatter", () => {
		// when
		const result = composeCardDirective(["fleet-implement"], { baseRef: "production-line" });
		// then
		expect(result).toBe(`${declaredDirective("fleet-implement")}\n\n`);
	});

	it("given a build card skill, when composed, then the directive mandates reporting a card premise found false", () => {
		// when
		const result = composeCardDirective(["fleet-implement"], { baseRef: "production-line" });
		// then
		expect(result).toContain("Card premises are claims, not givens");
		expect(result).toContain("stop and report it instead of implementing around it");
	});

	it("given a build card skill, when composed, then the directive requires the card to end with a retro", () => {
		// when
		const result = composeCardDirective(["fleet-implement"], { baseRef: "production-line" });
		// then
		expect(result).toContain("## Retro");
		expect(result).toContain("what made this harder than it should be");
	});

	it("given a plan card skill (fleet-plan), when composed, then it is sourced verbatim from that skill's own frontmatter", () => {
		// when
		const result = composeCardDirective(["fleet-plan"], { baseRef: "production-line" });
		// then
		expect(result).toBe(`${declaredDirective("fleet-plan")}\n\n`);
	});

	it("given a stack of build and PR skills, when composed, then each directive appears once, in the order given", () => {
		// given
		const baseRef = "production-line";
		// when
		const result = composeCardDirective(["fleet-implement", "fleet-pr"], { baseRef });
		// then
		const implement = declaredDirective("fleet-implement");
		const pr = declaredDirective("fleet-pr").replace(/\$\{baseRef\}/g, baseRef);
		expect(result).toBe(`${implement}\n\n${pr}\n\n`);
	});

	it("given a different baseRef for a stack, when composed, then that baseRef is templated into the PR directive", () => {
		// given
		const baseRef = "main";
		// when
		const result = composeCardDirective(["fleet-implement", "fleet-pr"], { baseRef });
		// then
		expect(result).toContain("against this card's base branch `main`");
		expect(result).not.toContain("${baseRef}");
	});

	it("given an empty skill list, when composed, then it returns an empty string", () => {
		// when
		const result = composeCardDirective([], { baseRef: "production-line" });
		// then
		expect(result).toBe("");
	});

	it("given a dormant skill like fleet-review, when composed, then it generates its directive correctly", () => {
		// when
		const result = composeCardDirective(["fleet-review"], { baseRef: "production-line" });
		// then
		expect(result).toBe("You are working a review card. Use the fleet-review skill.\n\n");
	});

	it("given a project skill, when composed, then its project directive is included", () => {
		// given
		const workspacePath = createTempDir("kanban-project-skill-workspace-");
		writeSkill(join(workspacePath, "fleet", "skills"), "my-skill", "Project instruction for $" + "{baseRef}.");

		// when
		const result = composeCardDirective(["my-skill"], {
			baseRef: "production-line",
			workspacePath,
		});

		// then
		expect(result).toBe("Project instruction for production-line.\n\n");
	});

	it("given project and bundled skills with the same name, when composed, then the project directive wins", () => {
		// given
		const workspacePath = createTempDir("kanban-shadow-workspace-");
		const bundledSkillsDir = createTempDir("kanban-shadow-bundled-");
		writeSkill(join(workspacePath, "fleet", "skills"), "fleet-pr", "Project PR instruction.");
		writeSkill(bundledSkillsDir, "fleet-pr", "Bundled PR instruction.");

		// when
		const result = composeCardDirective(["fleet-pr"], {
			baseRef: "production-line",
			workspacePath,
			canonicalSkillsDir: bundledSkillsDir,
		});

		// then
		expect(result).toBe("Project PR instruction.\n\n");
	});
});
