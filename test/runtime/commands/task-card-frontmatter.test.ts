import { describe, expect, it } from "vitest";

import {
	deriveCardTitleFromBody,
	parseCodeReference,
	parseTaskCardDocument,
	resolveCardSourceRequest,
	resolveTaskCardCreate,
} from "../../../src/commands/task-card-frontmatter";

describe("parseTaskCardDocument frontmatter mapping", () => {
	it("maps frontmatter fields onto the create fields", () => {
		const card = parseTaskCardDocument(
			[
				"---",
				"title: Add the widget",
				"agent: codex",
				"model: claude-haiku-4-5",
				"skill: fleet-smoke",
				"base-ref: feature/x",
				"auto-review: pr",
				"plan: true",
				"issue: ENG-123",
				"---",
				"Build the widget end to end.",
			].join("\n"),
		);

		expect(card.title).toBe("Add the widget");
		expect(card.agentId).toBe("codex");
		expect(card.agentModel).toBe("claude-haiku-4-5");
		expect(card.skill).toBe("fleet-smoke");
		expect(card.baseRef).toBe("feature/x");
		expect(card.autoReviewEnabled).toBe(true);
		expect(card.autoReviewMode).toBe("pr");
		expect(card.startInPlanMode).toBe(true);
		expect(card.externalIssueRef).toBe("ENG-123");
		expect(card.prompt).toBe("Build the widget end to end.");
	});

	it("keeps the Markdown body as the prompt verbatim", () => {
		const body = ["## Goal", "", "Do the thing.", "", "- step one", "- step two"].join("\n");
		const card = parseTaskCardDocument(["---", "agent: claude", "---", body].join("\n"));
		expect(card.prompt).toBe(body);
	});

	it("treats a document without frontmatter as a bare prompt", () => {
		const card = parseTaskCardDocument("Just a prompt with no frontmatter.");
		expect(card.prompt).toBe("Just a prompt with no frontmatter.");
		expect(card.title).toBe("Just a prompt with no frontmatter.");
		// auto-review defaults to pr for the Markdown-card path.
		expect(card.autoReviewEnabled).toBe(true);
		expect(card.autoReviewMode).toBe("pr");
	});

	it("defaults auto-review to pr when omitted, and off disables it", () => {
		expect(parseTaskCardDocument("body").autoReviewMode).toBe("pr");
		const off = parseTaskCardDocument(["---", "auto-review: off", "---", "body"].join("\n"));
		expect(off.autoReviewEnabled).toBe(false);
		expect(off.autoReviewMode).toBeUndefined();
	});

	it("migrates legacy auto-review commit cards to off", () => {
		const card = parseTaskCardDocument(["---", "auto-review: commit", "---", "body"].join("\n"));
		expect(card.autoReviewEnabled).toBe(false);
		expect(card.autoReviewMode).toBeUndefined();
	});

	it("maps agent: default to a null (cleared) override", () => {
		const card = parseTaskCardDocument(["---", "agent: default", "---", "body"].join("\n"));
		expect(card.agentId).toBeNull();
	});
});

describe("title derivation", () => {
	it("derives the title from the first H1 heading, stripping the marker", () => {
		const card = parseTaskCardDocument(["---", "agent: codex", "---", "# Real Title", "", "body"].join("\n"));
		expect(card.title).toBe("Real Title");
	});

	it("derives the title from the first non-empty line when there is no heading", () => {
		expect(deriveCardTitleFromBody("First line becomes the title.\nsecond line")).toBe(
			"First line becomes the title.",
		);
	});

	it("prefers an explicit frontmatter title over the body", () => {
		const card = parseTaskCardDocument(["---", "title: Explicit", "---", "# Heading", "body"].join("\n"));
		expect(card.title).toBe("Explicit");
	});
});

describe("code-references", () => {
	it.each([
		["40cc6b6", { kind: "commit", sha: "40cc6b6" }],
		["#43", { kind: "pr", number: "43" }],
		["43", { kind: "pr", number: "43" }],
	])("parses %s", (input, expected) => {
		expect(parseCodeReference(input)).toEqual(expected);
	});

	it("rejects a malformed code reference", () => {
		expect(() => parseCodeReference("not-a-ref")).toThrow(/not a commit SHA/);
	});

	it("renders a Code references section into the prompt", () => {
		const card = parseTaskCardDocument(
			["---", "code-references:", "  - 40cc6b6", "  - '#43'", "---", "Do the work."].join("\n"),
		);
		expect(card.codeReferences).toEqual([
			{ kind: "commit", sha: "40cc6b6" },
			{ kind: "pr", number: "43" },
		]);
		expect(card.prompt).toContain("## Code references (read these first)");
		expect(card.prompt).toContain("git show 40cc6b6");
		expect(card.prompt).toContain("gh pr view 43 --diff");
		expect(card.prompt.startsWith("Do the work.")).toBe(true);
	});

	it("does not duplicate the section when the body already has one", () => {
		const body = ["Do the work.", "", "## Code references", "- see the prior PR"].join("\n");
		const card = parseTaskCardDocument(["---", "code-references:", "  - 40cc6b6", "---", body].join("\n"));
		expect(card.prompt).toBe(body);
		// the list is still recorded even though nothing was rendered
		expect(card.codeReferences).toHaveLength(1);
	});

	it("accepts a bare YAML integer as a PR number", () => {
		const card = parseTaskCardDocument(["---", "code-references:", "  - 43", "---", "body"].join("\n"));
		expect(card.codeReferences).toEqual([{ kind: "pr", number: "43" }]);
	});
});

describe("links", () => {
	it("records the links list", () => {
		const card = parseTaskCardDocument(["---", "links:", "  - abc123", "  - def456", "---", "body"].join("\n"));
		expect(card.links).toEqual(["abc123", "def456"]);
	});
});

describe("invalid frontmatter", () => {
	it("rejects unknown keys", () => {
		expect(() => parseTaskCardDocument(["---", "bogus: nope", "---", "body"].join("\n"))).toThrow(
			/unknown key\(s\): bogus/,
		);
	});

	it("rejects a bad agent value and lists valid values", () => {
		expect(() => parseTaskCardDocument(["---", "agent: wizard", "---", "body"].join("\n"))).toThrow(
			/"agent" must be one of/,
		);
	});

	it("rejects a bad auto-review value", () => {
		expect(() => parseTaskCardDocument(["---", "auto-review: sometimes", "---", "body"].join("\n"))).toThrow(
			/"auto-review" must be one of: pr, off/,
		);
	});

	it("rejects a non-boolean plan value", () => {
		expect(() => parseTaskCardDocument(["---", "plan: yes-please", "---", "body"].join("\n"))).toThrow(
			/"plan" must be a boolean/,
		);
	});

	it("given the frontmatter has an empty skill value, when parsed, then it hard-errors", () => {
		expect(() => parseTaskCardDocument(["---", "skill: ''", "---", "body"].join("\n"))).toThrow(
			/"skill" must be a non-empty string/,
		);
	});

	it("rejects a malformed code-references entry", () => {
		expect(() => parseTaskCardDocument(["---", "code-references:", "  - nope", "---", "body"].join("\n"))).toThrow(
			/not a commit SHA/,
		);
	});
});

describe("resolveCardSourceRequest", () => {
	it("returns none when neither flag is set", () => {
		expect(resolveCardSourceRequest({})).toEqual({ kind: "none" });
	});

	it("returns inline for --markdown", () => {
		expect(resolveCardSourceRequest({ markdown: "hi" })).toEqual({ kind: "inline", text: "hi" });
	});

	it("returns file for --file <path>", () => {
		expect(resolveCardSourceRequest({ file: "docs/scratch/tasks/x.md" })).toEqual({
			kind: "file",
			path: "docs/scratch/tasks/x.md",
		});
	});

	it("returns stdin for --file -", () => {
		expect(resolveCardSourceRequest({ file: "-" })).toEqual({ kind: "stdin" });
	});

	it("rejects passing both --file and --markdown", () => {
		expect(() => resolveCardSourceRequest({ file: "x.md", markdown: "hi" })).toThrow(/not both/);
	});
});

describe("resolveTaskCardCreate precedence", () => {
	const baseCard = parseTaskCardDocument(
		[
			"---",
			"title: From card",
			"agent: codex",
			"skill: fleet-smoke",
			"base-ref: card-branch",
			"---",
			"Card body.",
		].join("\n"),
	);

	it("uses frontmatter values when no flags are given", () => {
		const resolved = resolveTaskCardCreate(baseCard, {});
		expect(resolved.title).toBe("From card");
		expect(resolved.agentId).toBe("codex");
		expect(resolved.skill).toBe("fleet-smoke");
		expect(resolved.baseRef).toBe("card-branch");
		expect(resolved.prompt).toBe("Card body.");
	});

	it("lets explicit flags override frontmatter", () => {
		const resolved = resolveTaskCardCreate(baseCard, {
			title: "From flag",
			agentId: "claude",
			skill: "other-skill",
			baseRef: "flag-branch",
		});
		expect(resolved.title).toBe("From flag");
		expect(resolved.agentId).toBe("claude");
		expect(resolved.skill).toBe("other-skill");
		expect(resolved.baseRef).toBe("flag-branch");
	});

	it("collapses an explicit default (null) agent override to undefined", () => {
		const resolved = resolveTaskCardCreate(baseCard, { agentId: null });
		expect(resolved.agentId).toBeUndefined();
	});

	it("works with no card at all when a prompt flag is provided", () => {
		const resolved = resolveTaskCardCreate(undefined, { prompt: "flag prompt" });
		expect(resolved.prompt).toBe("flag prompt");
		expect(resolved.links).toEqual([]);
	});

	it("throws when neither a card body nor a prompt flag is available", () => {
		expect(() => resolveTaskCardCreate(undefined, {})).toThrow(/requires a prompt/);
	});
});
