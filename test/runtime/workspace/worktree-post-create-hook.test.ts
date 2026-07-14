import { describe, expect, it } from "vitest";

import { buildWorktreeHookEnv, runWorktreePostCreateHook } from "../../../src/workspace/worktree-post-create-hook";

describe("worktree post-create hook", () => {
	it("builds the hook environment with Kanban context and CLINE_HOME", () => {
		const env = buildWorktreeHookEnv({
			taskId: "task-1",
			workspaceId: "workspace-1",
			worktreePath: "/tmp/worktree",
			repoPath: "/tmp/repo",
			baseRef: "main",
			clineHome: "/tmp/cline-home",
			env: { EXISTING: "1" },
		});

		expect(env.EXISTING).toBe("1");
		expect(env.KANBAN_TASK_ID).toBe("task-1");
		expect(env.KANBAN_WORKSPACE_ID).toBe("workspace-1");
		expect(env.KANBAN_WORKTREE_PATH).toBe("/tmp/worktree");
		expect(env.KANBAN_REPO_PATH).toBe("/tmp/repo");
		expect(env.KANBAN_BASE_REF).toBe("main");
		expect(env.CLINE_HOME).toBe("/tmp/cline-home");
	});

	it("returns ok for a successful command", async () => {
		const result = await runWorktreePostCreateHook(
			{ postCreateCommand: [process.execPath, "-e", "console.log(process.cwd())"] },
			createContext(),
		);

		expect(result.ok).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.timedOut).toBe(false);
		expect(result.outputTail).toContain(process.cwd());
	});

	it("captures a non-zero exit and output tail", async () => {
		const result = await runWorktreePostCreateHook(
			{ postCreateCommand: [process.execPath, "-e", "console.error('hook failed'); process.exit(7)"] },
			createContext(),
		);

		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(7);
		expect(result.timedOut).toBe(false);
		expect(result.outputTail).toContain("hook failed");
	});

	it("times out and reports timedOut", async () => {
		const result = await runWorktreePostCreateHook(
			{ postCreateCommand: [process.execPath, "-e", "setTimeout(() => {}, 5000)"] },
			createContext({ timeoutMs: 50 }),
		);

		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(true);
	});

	it("truncates output tail to the configured cap", async () => {
		const result = await runWorktreePostCreateHook(
			{ postCreateCommand: [process.execPath, "-e", "console.log('a'.repeat(200) + 'TAIL')"] },
			createContext({ outputTailBytes: 16 }),
		);

		expect(Buffer.byteLength(result.outputTail, "utf8")).toBeLessThanOrEqual(16);
		expect(result.outputTail).toContain("TAIL");
	});
});

function createContext(
	overrides?: Partial<Parameters<typeof runWorktreePostCreateHook>[1]>,
): Parameters<typeof runWorktreePostCreateHook>[1] {
	return {
		taskId: "task-1",
		workspaceId: "workspace-1",
		worktreePath: process.cwd(),
		repoPath: process.cwd(),
		baseRef: "main",
		clineHome: "/tmp/cline-home",
		...overrides,
	};
}
