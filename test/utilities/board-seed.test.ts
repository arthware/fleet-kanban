import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runtimeBoardDataSchema } from "../../src/core/api-contract";
import {
	createStubLifecycleBoard,
	LINKED_CHILD_TASK_ID,
	LINKED_PARENT_TASK_ID,
	STUB_LIFECYCLE_TASK_ID,
	seedIsolatedBoardState,
} from "./board-seed";
import { createTempDir } from "./temp-dir";

describe("board seed helper", () => {
	it("creates a schema-valid board with a stub card and linked backlog cards", () => {
		const board = createStubLifecycleBoard();
		expect(runtimeBoardDataSchema.parse(board)).toEqual(board);
		expect(board.columns.find((column) => column.id === "backlog")?.cards.map((card) => card.id)).toEqual([
			STUB_LIFECYCLE_TASK_ID,
			LINKED_PARENT_TASK_ID,
			LINKED_CHILD_TASK_ID,
		]);
		expect(board.dependencies).toEqual([
			expect.objectContaining({
				fromTaskId: LINKED_CHILD_TASK_ID,
				toTaskId: LINKED_PARENT_TASK_ID,
			}),
		]);
	});

	it("writes board.json, sessions.json, and meta.json under the isolated CLINE_HOME layout", () => {
		const temp = createTempDir("kanban-board-seed-");
		try {
			seedIsolatedBoardState({ homeDir: temp.path, workspaceId: "pet-repo" });
			const workspaceDir = join(temp.path, ".cline/kanban/workspaces/pet-repo");
			expect(existsSync(join(workspaceDir, "board.json"))).toBe(true);
			expect(existsSync(join(workspaceDir, "sessions.json"))).toBe(true);
			expect(existsSync(join(workspaceDir, "meta.json"))).toBe(true);
			const board = JSON.parse(readFileSync(join(workspaceDir, "board.json"), "utf8")) as unknown;
			expect(runtimeBoardDataSchema.parse(board).columns[0]?.cards[0]?.id).toBe(STUB_LIFECYCLE_TASK_ID);
		} finally {
			temp.cleanup();
		}
	});
});
