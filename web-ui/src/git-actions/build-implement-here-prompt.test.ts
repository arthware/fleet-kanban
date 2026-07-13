import { describe, expect, it } from "vitest";

import { buildImplementHerePrompt } from "@/git-actions/build-implement-here-prompt";

describe("buildImplementHerePrompt", () => {
	it("given a resolved design-doc path, when the prompt is built, then it carries that exact path", () => {
		// given a resolved design-doc path
		const designDocPath = "docs/design/ENG-142-done-vs-trash-lifecycle.md";

		// when the prompt is built
		const prompt = buildImplementHerePrompt(designDocPath);

		// then it names that exact path and instructs the agent to build in place
		expect(prompt).toContain("`docs/design/ENG-142-done-vs-trash-lifecycle.md`");
		expect(prompt).toContain("approved");
		expect(prompt).toContain("in this same session");
		expect(prompt).toContain("Keep all existing tests green");
		expect(prompt).toContain("open a PR against production-line");
	});
});
