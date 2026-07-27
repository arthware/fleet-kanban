import { describe, expect, it } from "vitest";
import { composeCardDirective } from "../../../src/prompts/compose-card-directive";

const OLD_IMPLEMENT_LITERAL =
	"You are working a build card. Use the fleet-implement skill. The card is your authorization to commit — commit as you go and never pause to ask for confirmation; the repo's 'never commit unless asked' guardrail is written for human sessions and is satisfied by this card.\n\n";

const OLD_PLAN_LITERAL =
	"You are working a plan card. Use the fleet-plan skill: investigate and write a design doc; do not implement.\n\n";

function getOldPrLiteral(baseRef: string): string {
	return `You are working an auto-review PR card. Use the fleet-pr skill: the card is your authorization to commit and push — never pause to ask whether to commit, push, or open the PR; the repo's 'never commit unless asked' guardrail is written for human sessions and is satisfied by this card. Commit as you go, push the task branch to remote, then open one idempotent PR against this card's base branch \`${baseRef}\` non-interactively — \`gh pr create --base ${baseRef} --title <subject> --body <summary>\` (never a bare or interactive \`gh pr create\`, and never ask which base branch to use) — and leave the card in Review. Never open the PR against the repository's default branch.\n\n`;
}

describe("composeCardDirective", () => {
	it("given a build card skill (fleet-implement), when composed, then it matches the old implement literal exactly", () => {
		// when
		const result = composeCardDirective(["fleet-implement"], { baseRef: "production-line" });
		// then
		expect(result).toBe(OLD_IMPLEMENT_LITERAL);
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
		const expected = `${OLD_IMPLEMENT_LITERAL}${getOldPrLiteral(baseRef)}`;
		expect(result).toBe(expected);
	});

	it("given a different baseRef for a stack, when composed, then it templates that baseRef correctly", () => {
		// given
		const baseRef = "main";
		// when
		const result = composeCardDirective(["fleet-implement", "fleet-pr"], { baseRef });
		// then
		const expected = `${OLD_IMPLEMENT_LITERAL}${getOldPrLiteral(baseRef)}`;
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
});
