import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { LIFECYCLE_TRANSITION_MATRIX } from "../../selfcheck/transition-matrix";

const REPO_ROOT = resolve(__dirname, "../../..");

describe("lifecycle transition matrix", () => {
	it("keeps every enumerated transition tied to an executable scenario or unit spec", () => {
		const uncovered = LIFECYCLE_TRANSITION_MATRIX.filter((row) => row.pinnedBy.length === 0);

		expect(uncovered).toEqual([]);
	});

	it("names test files that still exist, so a renamed spec cannot silently unpin a transition", () => {
		const missing = LIFECYCLE_TRANSITION_MATRIX.flatMap((row) =>
			row.pinnedBy.filter((path) => !existsSync(resolve(REPO_ROOT, path))).map((path) => `${row.id}: ${path}`),
		);

		expect(missing).toEqual([]);
	});

	it("uses stable unique row ids so reviewers can diff the state-machine coverage", () => {
		const ids = LIFECYCLE_TRANSITION_MATRIX.map((row) => row.id);

		expect(new Set(ids).size).toBe(ids.length);
	});
});
