import { describe, expect, it } from "vitest";

import type { RuntimeProjectSummary } from "../../../src/core/api-contract";
import { sumInProgressTaskCounts } from "../../../src/server/workspace-registry";

function makeProject(id: string, in_progress: number): RuntimeProjectSummary {
	return {
		id,
		path: `/tmp/${id}`,
		name: id,
		taskCounts: { backlog: 0, in_progress, review: 0, done: 0, trash: 0 },
	};
}

describe("sumInProgressTaskCounts", () => {
	it("given no projects, when summed, then it returns zero", () => {
		const result = sumInProgressTaskCounts([]);

		expect(result).toBe(0);
	});

	it("given several projects with in-progress cards, when summed, then it returns the total across all projects", () => {
		const projects = [makeProject("a", 2), makeProject("b", 0), makeProject("c", 3)];

		const result = sumInProgressTaskCounts(projects);

		expect(result).toBe(5);
	});
});
