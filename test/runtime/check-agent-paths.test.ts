import { describe, expect, it } from "vitest";

// @ts-expect-error - Importing untyped ES module into TypeScript
import * as checkAgentPathsModule from "../../scripts/check-agent-paths.mjs";

const { checkContent } = checkAgentPathsModule as unknown as {
	checkContent: (content: string, relativePath: string) => Array<{ line: number; text: string }>;
};

describe("check-agent-paths gate validation", () => {
	it("fails on embedded agent path literals inside any string or template format", () => {
		const cases = [
			'const p = "~/.codex/sessions/x";',
			"const p = `" + "$" + "{home}/.gemini/tmp`;",
			'const p = ".claude/projects/a.jsonl";',
			'const p = join(h, ".codex");',
		];

		for (const code of cases) {
			const errors = checkContent(code, "test/runtime/some-test.test.ts");
			expect(errors).toHaveLength(1);
			expect(errors[0].text).toBe(code);
		}
	});

	it("passes on legal directories like src/agents/ or test/fixtures/", () => {
		const code = 'const p = "~/.codex/sessions/x";';

		// Driver files are legal
		expect(checkContent(code, "src/agents/codex/driver.ts")).toHaveLength(0);

		// Fixtures are legal
		expect(checkContent(code, "test/fixtures/agent-paths.ts")).toHaveLength(0);
	});

	it("safely ignores comments containing agent directories", () => {
		const code = `
			// This is a comment mentioning .claude projects directory
			/* Another block comment mentioning .gemini/tmp */
			const legal = 1;
		`;
		expect(checkContent(code, "test/runtime/some-test.test.ts")).toHaveLength(0);
	});
});
