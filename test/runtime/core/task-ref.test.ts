import { describe, expect, it } from "vitest";

import {
	deriveTaskBranchName,
	resolveDesignDocRefCandidates,
	resolveTaskRef,
	sanitizeDesignDocRef,
} from "../../../src/core/task-ref";

describe("task ref helpers", () => {
	it.each([
		["ENG-123", "eng-123"],
		["owner/repo#12", "owner-repo-12"],
		["#12", "12"],
		["Fix API_v2.now", "fix-api-v2-now"],
	])("sanitizes %s as %s", (input, expected) => {
		expect(sanitizeDesignDocRef(input)).toBe(expected);
	});

	it("prefers the external issue key before falling back to the task id", () => {
		expect(resolveTaskRef({ taskId: "36AB1", externalIssueKey: "ENG-142" })).toBe("eng-142");
		expect(resolveTaskRef({ taskId: "36AB1" })).toBe("36ab1");
		expect(resolveDesignDocRefCandidates({ taskId: "36AB1", externalIssueKey: "ENG-142" }).slice(0, 2)).toEqual([
			"eng-142",
			"36ab1",
		]);
	});

	it("keeps legacy design doc ref candidates after canonical branch-safe refs", () => {
		expect(resolveDesignDocRefCandidates({ taskId: "36AB1", externalIssueKey: "ENG-142" })).toEqual([
			"eng-142",
			"36ab1",
			"ENG-142",
			"36AB1",
		]);
	});

	it("derives the same ref prefix for branches and design docs", () => {
		const card = {
			taskId: "36ab1",
			externalIssueKey: "ENG-142",
			title: "Design: create a named branch at worktree creation",
			prompt: "",
		};

		const [designDocRef] = resolveDesignDocRefCandidates(card);

		expect(deriveTaskBranchName(card)).toBe(`${designDocRef}-design-create-a-named-branch-at-worktree-creation`);
	});

	it("uses the bare ref when the title slug is empty", () => {
		expect(
			deriveTaskBranchName({
				taskId: "36ab1",
				title: "🚀 !!!",
				prompt: "",
			}),
		).toBe("36ab1");
	});

	it("caps long names on a dash boundary", () => {
		const branchName = deriveTaskBranchName({
			taskId: "36ab1",
			title: "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda",
			prompt: "",
		});

		expect(branchName.length).toBeLessThanOrEqual(60);
		expect(branchName).toBe("36ab1-alpha-beta-gamma-delta-epsilon-zeta-eta-theta-iota");
		expect(branchName.endsWith("-")).toBe(false);
	});
});
