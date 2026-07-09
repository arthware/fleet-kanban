import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "../../src/config/runtime-config";
import type { RuntimeBoardData } from "../../src/core/api-contract";
import type { GitRepositoryProbe } from "../../src/core/git-repository-probe";
import { createWorkspaceRegistry } from "../../src/server/workspace-registry";
// Keep every real behaviour of the workspace-state store, but replace the two
// destructive primitives with spies so a test can prove the reconnect path
// never reaches for them. Casting through the namespace type avoids inline
// import types (house rule) while keeping the spread fully typed.
import * as workspaceState from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

vi.mock("../../src/state/workspace-state", async (importOriginal) => {
	const actual = (await importOriginal()) as typeof workspaceState;
	return {
		...actual,
		removeWorkspaceStateFiles: vi.fn(),
		removeWorkspaceIndexEntry: vi.fn(),
	};
});

function createBoard(title: string): RuntimeBoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [
					{
						id: "task-1",
						title,
						prompt: title,
						startInPlanMode: false,
						baseRef: "main",
						createdAt: 1,
						updatedAt: 1,
					},
				],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], { cwd: path, stdio: "ignore", env: createGitTestEnv() });
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

interface SeededWorkspace {
	repoPath: string;
	workspaceId: string;
	cleanup: () => void;
}

async function seedWorkspaceWithBoard(): Promise<SeededWorkspace> {
	const { path: sandboxRoot, cleanup } = createTempDir("kanban-registry-reconnect-");
	const repoPath = join(sandboxRoot, "project");
	mkdirSync(repoPath, { recursive: true });
	initGitRepository(repoPath);

	const context = await workspaceState.loadWorkspaceContext(repoPath);
	const initial = await workspaceState.loadWorkspaceState(repoPath);
	await workspaceState.saveWorkspaceState(repoPath, {
		board: createBoard("Durable task"),
		sessions: {},
		expectedRevision: initial.revision,
	});

	return { repoPath, workspaceId: context.workspaceId, cleanup };
}

function createRegistry(probe: () => GitRepositoryProbe) {
	return createWorkspaceRegistry({
		// Point the registry at a path that is not the seeded repo so it hydrates
		// from the persisted index rather than the launch cwd.
		cwd: "/nonexistent-launch-cwd",
		loadGlobalRuntimeConfig,
		loadRuntimeConfig,
		probeGitRepository: probe,
		pathIsDirectory: async () => true,
	});
}

// Relocate the entire Kanban home to a throwaway directory for each test.
// `CLINE_HOME` takes precedence over `$HOME` in `clineHomeDir()`, so it MUST be
// overridden here — otherwise a `CLINE_HOME` inherited from the shell would
// point these tests at the real product home.
const originalClineHome = process.env.CLINE_HOME;
let homeCleanup: (() => void) | null = null;

beforeEach(() => {
	const { path: tempHome, cleanup } = createTempDir("kanban-home-");
	homeCleanup = cleanup;
	process.env.CLINE_HOME = tempHome;
	vi.mocked(workspaceState.removeWorkspaceStateFiles).mockClear();
	vi.mocked(workspaceState.removeWorkspaceIndexEntry).mockClear();
});

afterEach(() => {
	if (originalClineHome === undefined) {
		delete process.env.CLINE_HOME;
	} else {
		process.env.CLINE_HOME = originalClineHome;
	}
	homeCleanup?.();
	homeCleanup = null;
});

describe.sequential("resolveWorkspaceForStream keeps durable state on a probe miss", () => {
	it("does not delete a project whose git probe reports no on reconnect", async () => {
		const seeded = await seedWorkspaceWithBoard();
		try {
			const registry = await createRegistry(() => "no");
			await registry.resolveWorkspaceForStream(seeded.workspaceId);

			const entries = await workspaceState.listWorkspaceIndexEntries();
			expect(entries.map((entry) => entry.workspaceId)).toContain(seeded.workspaceId);
			expect(existsSync(workspaceState.getWorkspaceDirectoryPath(seeded.workspaceId))).toBe(true);
			expect(workspaceState.removeWorkspaceStateFiles).not.toHaveBeenCalled();
			expect(workspaceState.removeWorkspaceIndexEntry).not.toHaveBeenCalled();
			expect(registry.isWorkspaceUnavailable(seeded.workspaceId)).toBe(true);
		} finally {
			seeded.cleanup();
		}
	});

	it("does not delete a project whose directory has vanished", async () => {
		const seeded = await seedWorkspaceWithBoard();
		try {
			const registry = await createWorkspaceRegistry({
				cwd: "/nonexistent-launch-cwd",
				loadGlobalRuntimeConfig,
				loadRuntimeConfig,
				probeGitRepository: () => "unknown",
				pathIsDirectory: async () => false,
			});
			await registry.resolveWorkspaceForStream(seeded.workspaceId);

			const entries = await workspaceState.listWorkspaceIndexEntries();
			expect(entries.map((entry) => entry.workspaceId)).toContain(seeded.workspaceId);
			expect(existsSync(workspaceState.getWorkspaceDirectoryPath(seeded.workspaceId))).toBe(true);
			expect(workspaceState.removeWorkspaceStateFiles).not.toHaveBeenCalled();
			expect(registry.isWorkspaceUnavailable(seeded.workspaceId)).toBe(true);
		} finally {
			seeded.cleanup();
		}
	});

	it("keeps a project when the git probe throws (treated as unknown)", async () => {
		const seeded = await seedWorkspaceWithBoard();
		try {
			const registry = await createRegistry(() => {
				throw new Error("spawnSync exploded");
			});
			await registry.resolveWorkspaceForStream(seeded.workspaceId);

			const entries = await workspaceState.listWorkspaceIndexEntries();
			expect(entries.map((entry) => entry.workspaceId)).toContain(seeded.workspaceId);
			expect(existsSync(workspaceState.getWorkspaceDirectoryPath(seeded.workspaceId))).toBe(true);
			expect(workspaceState.removeWorkspaceStateFiles).not.toHaveBeenCalled();
		} finally {
			seeded.cleanup();
		}
	});

	it("re-lists the project across a reconnect when the probe flips no then yes", async () => {
		const seeded = await seedWorkspaceWithBoard();
		try {
			let probeResult: GitRepositoryProbe = "no";
			const registry = await createRegistry(() => probeResult);

			// First (failing) reconnect: the project is greyed out but still listed.
			await registry.resolveWorkspaceForStream(seeded.workspaceId);
			const whileUnavailable = await registry.buildProjectsPayload(seeded.workspaceId);
			expect(whileUnavailable.projects.map((project) => project.id)).toContain(seeded.workspaceId);
			expect(registry.isWorkspaceUnavailable(seeded.workspaceId)).toBe(true);

			// Probe recovers on the next reconnect: the project is available again.
			probeResult = "yes";
			const resolved = await registry.resolveWorkspaceForStream(seeded.workspaceId);
			expect(resolved.workspaceId).toBe(seeded.workspaceId);

			const afterRecovery = await registry.buildProjectsPayload(seeded.workspaceId);
			expect(afterRecovery.projects.map((project) => project.id)).toContain(seeded.workspaceId);
			expect(registry.isWorkspaceUnavailable(seeded.workspaceId)).toBe(false);
		} finally {
			seeded.cleanup();
		}
	});
});
