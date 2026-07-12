import { describe, expect, it } from "vitest";

import { parseExternalIssueRef } from "../../../src/core/external-issue";

describe("parseExternalIssueRef", () => {
	it.each([
		[
			"full Linear URL",
			" https://linear.app/acme/issue/ENG-123/fix-the-thing ",
			{
				provider: "linear",
				key: "ENG-123",
				url: "https://linear.app/acme/issue/ENG-123/fix-the-thing",
				raw: "https://linear.app/acme/issue/ENG-123/fix-the-thing",
			},
		],
		[
			"full GitHub issue URL",
			"https://github.com/owner/repo/issues/42",
			{
				provider: "github",
				key: "owner/repo#42",
				url: "https://github.com/owner/repo/issues/42",
				raw: "https://github.com/owner/repo/issues/42",
			},
		],
		[
			"bare Linear key",
			"ENG-123",
			{
				provider: "linear",
				key: "ENG-123",
				raw: "ENG-123",
			},
		],
		[
			"GitHub owner/repo shorthand",
			"owner.name/repo-name#123",
			{
				provider: "github",
				key: "owner.name/repo-name#123",
				url: "https://github.com/owner.name/repo-name/issues/123",
				raw: "owner.name/repo-name#123",
			},
		],
		[
			"GitHub hash issue",
			"#123",
			{
				provider: "github",
				key: "#123",
				raw: "#123",
			},
		],
		[
			"GitHub bare issue number",
			"123",
			{
				provider: "github",
				key: "#123",
				raw: "123",
			},
		],
	] as const)("parses %s", (_name, input, expected) => {
		expect(parseExternalIssueRef(input)).toEqual(expected);
	});

	it.each(["", "eng-123", "ENG", "owner/repo", "owner/repo/pull/123", "https://github.com/o/r/pull/1"])(
		"rejects %s",
		(input) => {
			expect(parseExternalIssueRef(input)).toBeNull();
		},
	);
});
