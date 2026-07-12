import { describe, expect, it } from "vitest";

import { resolveExternalIssueForTaskCommand } from "../../../src/commands/task";

describe("resolveExternalIssueForTaskCommand", () => {
	it("adds a Linear URL when KANBAN_LINEAR_WORKSPACE is configured", async () => {
		await expect(
			resolveExternalIssueForTaskCommand({
				ref: "ENG-123",
				cwd: "/tmp",
				env: { KANBAN_LINEAR_WORKSPACE: "acme" },
			}),
		).resolves.toEqual({
			provider: "linear",
			key: "ENG-123",
			url: "https://linear.app/acme/issue/ENG-123",
			raw: "ENG-123",
		});
	});

	it("keeps a bare Linear key unlinked without KANBAN_LINEAR_WORKSPACE", async () => {
		await expect(
			resolveExternalIssueForTaskCommand({
				ref: "ENG-123",
				cwd: "/tmp",
				env: {},
			}),
		).resolves.toEqual({
			provider: "linear",
			key: "ENG-123",
			raw: "ENG-123",
		});
	});

	it("rejects unrecognized refs", async () => {
		await expect(resolveExternalIssueForTaskCommand({ ref: "not-an-issue", cwd: "/tmp", env: {} })).rejects.toThrow(
			"Invalid external issue reference",
		);
	});
});
