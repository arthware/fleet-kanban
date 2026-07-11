import { describe, expect, it } from "vitest";

import { classifyTaskWorkDurability, type TaskWorkDurabilitySignals } from "../../../src/workspace/durable-save";

// The predicate that gates a card becoming Done. It must fail SAFE: any doubt
// (uncommitted work, un-landed commits, unreadable git state) is "not durable"
// so the worktree — the only copy of the work — is retained. Only a clean tree
// whose commits are all present on the base branch is durable.
const durableCommit: TaskWorkDurabilitySignals = {
	worktreeExists: true,
	gitStateReadable: true,
	workingTreeClean: true,
	baseRefResolved: true,
	unlandedCommitCount: 0,
	mode: "commit",
};

describe("classifyTaskWorkDurability", () => {
	it("treats a missing worktree as durable — there is nothing to lose", () => {
		const result = classifyTaskWorkDurability({ ...durableCommit, worktreeExists: false });

		expect(result.durable).toBe(true);
		expect(result.status).toBe("no_worktree");
	});

	it("is durable in commit mode when the tree is clean and all commits landed", () => {
		const result = classifyTaskWorkDurability(durableCommit);

		expect(result.durable).toBe(true);
		expect(result.status).toBe("clean_and_landed");
	});

	it("is durable in pr mode when the tree is clean and all commits merged", () => {
		const result = classifyTaskWorkDurability({ ...durableCommit, mode: "pr" });

		expect(result.durable).toBe(true);
		expect(result.status).toBe("merged");
	});

	it("is NOT durable when the working tree is dirty — the incident case", () => {
		// A card that made edits but stalled at a `git commit` prompt: uncommitted work.
		const result = classifyTaskWorkDurability({ ...durableCommit, workingTreeClean: false });

		expect(result.durable).toBe(false);
		expect(result.status).toBe("uncommitted_changes");
	});

	it("is NOT durable in commit mode when commits have not landed on the base branch", () => {
		const result = classifyTaskWorkDurability({ ...durableCommit, unlandedCommitCount: 2 });

		expect(result.durable).toBe(false);
		expect(result.status).toBe("unlanded_commits");
		expect(result.detail).toContain("2 commits");
	});

	it("is NOT durable in pr mode when the PR has not been merged", () => {
		const result = classifyTaskWorkDurability({
			...durableCommit,
			mode: "pr",
			unlandedCommitCount: 1,
		});

		expect(result.durable).toBe(false);
		expect(result.status).toBe("awaiting_merge");
		expect(result.detail).toContain("1 commit");
	});

	it("fails safe (not durable) when git state cannot be read", () => {
		const result = classifyTaskWorkDurability({ ...durableCommit, gitStateReadable: false });

		expect(result.durable).toBe(false);
		expect(result.status).toBe("indeterminate");
	});

	it("fails safe (not durable) when the base ref cannot be resolved", () => {
		const result = classifyTaskWorkDurability({ ...durableCommit, baseRefResolved: false });

		expect(result.durable).toBe(false);
		expect(result.status).toBe("indeterminate");
	});
});
