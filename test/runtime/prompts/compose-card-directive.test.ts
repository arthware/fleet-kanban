import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { composeCardDirective } from "../../../src/prompts/compose-card-directive";

const IMPLEMENT_DIRECTIVE =
	"You are working a build card. Use the fleet-implement skill. The card is your authorization to commit — commit as you go and never pause to ask for confirmation; the repo's 'never commit unless asked' guardrail is written for human sessions and is satisfied by this card. Card premises are claims, not givens: if the card states something you can check and find false, stop and report it instead of implementing around it — contradicting the card is expected work.\n\n";

const OLD_PLAN_LITERAL =
	"You are working a plan card. Use the fleet-plan skill: investigate and write a design doc; do not implement.\n\n";

function getOldPrLiteral(baseRef: string): string {
	return `You are working an auto-review PR card. Use the fleet-pr skill: the card is your authorization to commit and push — never pause to ask whether to commit, push, or open the PR; the repo's 'never commit unless asked' guardrail is written for human sessions and is satisfied by this card. Commit as you go, push the task branch to remote, then open one idempotent PR against this card's base branch \`${baseRef}\` non-interactively — \`gh pr create --base ${baseRef} --title <subject> --body <summary>\` (never a bare or interactive \`gh pr create\`, and never ask which base branch to use) — and leave the card in Review. Never open the PR against the repository's default branch.\n\n`;
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

	it("given a build card skill (fleet-implement), when composed, then it matches the implement directive exactly", () => {
		// when
		const result = composeCardDirective(["fleet-implement"], { baseRef: "production-line" });
		// then
		expect(result).toBe(IMPLEMENT_DIRECTIVE);
	});

	it("given a build card skill, when composed, then the directive mandates reporting a card premise found false", () => {
		// when
		const result = composeCardDirective(["fleet-implement"], { baseRef: "production-line" });
		// then
		expect(result).toContain("Card premises are claims, not givens");
		expect(result).toContain("stop and report it instead of implementing around it");
	});

	it("given a plan card skill (fleet-plan), when composed, then it matches the old plan literal exactly", () => {
		// when
		const result = composeCardDirective(["fleet-plan"], { baseRef: "production-line" });
		// then
		expect(result).toBe(OLD_PLAN_LITERAL);
	});

	it("given a stack of build and PR skills, when composed, then it matches the old implement-then-PR stack exactly with baseRef interpolated", () => {
		// given
		const baseRef = "production-line";
		// when
		const result = composeCardDirective(["fleet-implement", "fleet-pr"], { baseRef });
		// then
		const expected = `${IMPLEMENT_DIRECTIVE}${getOldPrLiteral(baseRef)}`;
		expect(result).toBe(expected);
	});

	it("given a different baseRef for a stack, when composed, then it templates that baseRef correctly", () => {
		// given
		const baseRef = "main";
		// when
		const result = composeCardDirective(["fleet-implement", "fleet-pr"], { baseRef });
		// then
		const expected = `${IMPLEMENT_DIRECTIVE}${getOldPrLiteral(baseRef)}`;
		expect(result).toBe(expected);
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
