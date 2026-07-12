import { describe, expect, it } from "vitest";

import {
	parseGhRepoViewNameWithOwner,
	parseGithubRemoteNameWithOwner,
	resolveRepoNameWithOwner,
} from "../../../src/workspace/repo-name";

describe("repo-name helpers", () => {
	it("parses gh repo view nameWithOwner output", () => {
		expect(parseGhRepoViewNameWithOwner('{"nameWithOwner":"owner/repo"}')).toBe("owner/repo");
		expect(parseGhRepoViewNameWithOwner('{"nameWithOwner":""}')).toBeNull();
		expect(parseGhRepoViewNameWithOwner("not json")).toBeNull();
	});

	it.each([
		["git@github.com:owner/repo.git", "owner/repo"],
		["https://github.com/owner/repo.git", "owner/repo"],
		["https://github.com/owner/repo", "owner/repo"],
		["https://example.com/owner/repo.git", null],
	] as const)("parses GitHub origin %s", (remote, expected) => {
		expect(parseGithubRemoteNameWithOwner(remote)).toBe(expected);
	});

	it("resolves nameWithOwner through GhRunner", async () => {
		const result = await resolveRepoNameWithOwner("/repo", async () => '{"nameWithOwner":"owner/repo"}');

		expect(result).toBe("owner/repo");
	});

	it("returns null when gh and origin lookup fail", async () => {
		const result = await resolveRepoNameWithOwner("/definitely/not/a/repo", async () => {
			throw new Error("gh failed");
		});

		expect(result).toBeNull();
	});
});
