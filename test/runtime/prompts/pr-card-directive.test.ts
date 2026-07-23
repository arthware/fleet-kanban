import { describe, expect, it } from "vitest";
import { buildPrCardPromptDirective, prependPrCardDirective } from "../../../src/prompts/pr-card-directive";

describe("prependPrCardDirective", () => {
	it("given a PR auto-review card, when the prompt is built, then the directive names the card's literal base branch and an explicit --base instruction", () => {
		// given
		const prompt = "Do the thing.";
		// when
		const result = prependPrCardDirective(prompt, true, "pr", "production-line");
		// then
		expect(result).toBe(`${buildPrCardPromptDirective("production-line")}${prompt}`);
		expect(result).toContain("`production-line`");
		expect(result).toContain("gh pr create --base production-line");
	});

	it("given a PR auto-review card, when the prompt is built, then it instructs never targeting the repository's default branch", () => {
		// given
		const prompt = "Do the thing.";
		// when
		const result = prependPrCardDirective(prompt, true, "pr", "production-line");
		// then
		expect(result).toMatch(/never/i);
		expect(result).toContain("default branch");
	});

	it("given a different card base ref, when the prompt is built, then that literal ref is templated in instead", () => {
		// given
		const prompt = "Do the thing.";
		// when
		const result = prependPrCardDirective(prompt, true, "pr", "main");
		// then
		expect(result).toContain("`main`");
		expect(result).toContain("gh pr create --base main");
		expect(result).not.toContain("production-line");
	});

	it("given auto-review is disabled, when the prompt is built, then it is left unchanged", () => {
		// given
		const prompt = "Do the thing.";
		// when
		const result = prependPrCardDirective(prompt, false, "pr", "production-line");
		// then
		expect(result).toBe(prompt);
	});

	it("given auto-review mode is not pr, when the prompt is built, then it is left unchanged", () => {
		// given
		const prompt = "Do the thing.";
		// when
		const result = prependPrCardDirective(prompt, true, undefined, "production-line");
		// then
		expect(result).toBe(prompt);
	});

	it("given a PR auto-review card, when the prompt is built, then it mandates a non-interactive gh pr create with explicit title and body", () => {
		// given
		const prompt = "Do the thing.";
		// when
		const result = prependPrCardDirective(prompt, true, "pr", "production-line");
		// then
		expect(result).toContain("--title");
		expect(result).toContain("--body");
		expect(result).toMatch(/never.*(bare|interactive)/i);
	});

	it("given a PR auto-review card, when the prompt is built, then it instructs the agent to never ask which base branch to use", () => {
		// given
		const prompt = "Do the thing.";
		// when
		const result = prependPrCardDirective(prompt, true, "pr", "production-line");
		// then
		expect(result).toMatch(/never ask which base/i);
	});

	it("given a PR auto-review card, when the prompt is built, then it authorizes committing and pushing without pausing to ask permission", () => {
		// given
		const prompt = "Do the thing.";
		// when
		const result = prependPrCardDirective(prompt, true, "pr", "production-line");
		// then
		expect(result).toMatch(/card is your authorization to commit/i);
		expect(result).toMatch(/never pause to ask/i);
	});
});
