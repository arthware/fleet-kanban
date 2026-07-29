import { afterEach, describe, expect, it } from "vitest";

import { getKanbanRuntimePort, setKanbanRuntimePort } from "../../../src/core/runtime-endpoint";
import { type CreateRuntimeServerDependencies, createRuntimeServer } from "../../../src/server/runtime-server";
import { getAvailablePort } from "../../utilities/kanban-test-instance";

describe("runtime server liveness endpoint", () => {
	let originalRuntimePort: number | null = null;

	afterEach(() => {
		if (originalRuntimePort !== null) {
			setKanbanRuntimePort(originalRuntimePort);
			originalRuntimePort = null;
		}
	});

	it("given the process is serving, when probing liveness, then it responds without reading workspace state", async () => {
		const port = await getAvailablePort();
		originalRuntimePort = getKanbanRuntimePort();
		setKanbanRuntimePort(port);

		let workspaceStateTouched = false;
		const deps: CreateRuntimeServerDependencies = {
			workspaceRegistry: {
				getActiveWorkspaceId: () => {
					workspaceStateTouched = true;
					return null;
				},
				getActiveRuntimeConfig: () => {
					throw new Error("runtime config must not be read by liveness");
				},
				loadScopedRuntimeConfig: async () => {
					throw new Error("runtime config must not be loaded by liveness");
				},
				setActiveRuntimeConfig: () => {
					throw new Error("runtime config must not be written by liveness");
				},
				listManagedWorkspaces: () => [],
				clearActiveWorkspace: () => undefined,
				getActiveWorkspacePath: () => null,
				getWorkspacePathById: () => null,
				getTerminalManagerForWorkspace: () => null,
				ensureTerminalManagerForWorkspace: async () => {
					throw new Error("workspace terminal manager must not be created by liveness");
				},
				disposeWorkspace: () => ({ terminalManager: null, workspacePath: null }),
				rememberWorkspace: async () => {
					throw new Error("workspace state must not be written by liveness");
				},
				setActiveWorkspace: async () => {
					throw new Error("workspace state must not be selected by liveness");
				},
				summarizeProjectTaskCounts: async () => {
					throw new Error("workspace state must not be summarized by liveness");
				},
				createProjectSummary: ({ workspaceId, repoPath, taskCounts }) => {
					return { id: workspaceId, path: repoPath, name: workspaceId, taskCounts };
				},
				buildProjectsPayload: async () => {
					throw new Error("projects must not be listed by liveness");
				},
				buildWorkspaceStateSnapshot: async () => {
					throw new Error("workspace state must not be snapshotted by liveness");
				},
				getWorkspaceEpic: async () => null,
				setWorkspaceEpic: async () => undefined,
				resolveWorkspaceForStream: async () => ({ workspaceId: null, workspacePath: null }),
				isWorkspaceUnavailable: () => false,
			},
			runtimeStateHub: {
				trackTerminalManager: () => undefined,
				broadcastTaskChatCleared: async () => undefined,
				broadcastRuntimeWorkspaceStateUpdated: async () => undefined,
				broadcastRuntimeProjectsUpdated: async () => undefined,
				broadcastTaskReadyForReview: () => undefined,
				disposeWorkspace: () => undefined,
				handleUpgrade: () => undefined,
				close: async () => undefined,
			},
			warn: () => undefined,
			ensureTerminalManagerForWorkspace: async () => {
				throw new Error("terminal manager must not be created by liveness");
			},
			resolveInteractiveShellCommand: () => ({ binary: "sh", args: [] }),
			runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "", combinedOutput: "", durationMs: 0 }),
			resolveProjectInputPath: (inputPath) => inputPath,
			assertPathIsDirectory: async () => undefined,
			hasGitRepository: () => false,
			disposeWorkspace: () => ({ terminalManager: null, workspacePath: null }),
			collectProjectWorktreeTaskIdsForRemoval: () => new Set<string>(),
			pickDirectoryPathFromSystemDialog: () => null,
			getUpdateStatus: () => ({
				currentVersion: "0.0.0",
				latestVersion: null,
				updateAvailable: false,
				updateTiming: null,
				installCommand: null,
			}),
			runUpdateNow: async () => ({
				status: "already_up_to_date",
				currentVersion: "0.0.0",
				latestVersion: null,
				message: "No update available.",
			}),
		};
		const server = await createRuntimeServer(deps);

		try {
			workspaceStateTouched = false;
			const response = await fetch(`http://127.0.0.1:${port}/api/healthz`);

			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toEqual({ ok: true });
			expect(workspaceStateTouched).toBe(false);
		} finally {
			await server.close();
		}
	});
});
