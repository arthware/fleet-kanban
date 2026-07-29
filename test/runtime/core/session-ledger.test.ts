import * as fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	fsImpl,
	getHarvestedWorkspacesForTests,
	harvestSessions,
	listSessions,
	openSession,
} from "../../../src/core/session-ledger";

let previousClineHome: string | undefined;
let tempRoot: string;

async function writeSessionsJson(workspaceId: string, sessions: Record<string, unknown>): Promise<void> {
	const workspaceDir = join(tempRoot, "home", "kanban", "workspaces", workspaceId);
	await mkdir(workspaceDir, { recursive: true });
	await writeFile(join(workspaceDir, "sessions.json"), JSON.stringify(sessions, null, 2), "utf8");
}

async function writeWorkspaceIndex(workspaces: Record<string, { repoPath: string }>): Promise<void> {
	const workspacesDir = join(tempRoot, "home", "kanban", "workspaces");
	await mkdir(workspacesDir, { recursive: true });
	const indexFile = {
		version: 1,
		entries: Object.fromEntries(
			Object.entries(workspaces).map(([id, info]) => [
				id,
				{ workspaceId: id, repoPath: info.repoPath, createdAt: Date.now() },
			]),
		),
		repoPathToId: Object.fromEntries(Object.entries(workspaces).map(([id, info]) => [info.repoPath, id])),
	};
	await writeFile(join(workspacesDir, "index.json"), JSON.stringify(indexFile, null, 2), "utf8");
}

beforeEach(async () => {
	// Clear the one-shot module-level process guard before each test
	getHarvestedWorkspacesForTests().clear();

	previousClineHome = process.env.CLINE_HOME;
	tempRoot = await mkdtemp(join(tmpdir(), "kanban-session-ledger-test-"));
	process.env.CLINE_HOME = join(tempRoot, "home");
});

afterEach(async () => {
	if (previousClineHome === undefined) {
		delete process.env.CLINE_HOME;
	} else {
		process.env.CLINE_HOME = previousClineHome;
	}
	await rm(tempRoot, { recursive: true, force: true });
});

describe("Session Ledger API & Core Features", () => {
	it("givenNewSession_whenOpenSessionCalled_thenManifestAndIndexCreated", async () => {
		const manifest = await openSession({
			workspaceId: "ws-1",
			taskId: "card-123",
			kind: "card",
			generation: 0,
			agentId: "claude",
			agentSessionId: "session-uuid-1",
		});

		expect(manifest).toMatchObject({
			schemaVersion: 1,
			taskId: "card-123",
			kind: "card",
			generation: 0,
			agentId: "claude",
			agentSessionId: "session-uuid-1",
			outcome: "unknown",
		});

		const index = await listSessions("ws-1", "card-123");
		expect(index).not.toBeNull();
		if (index) {
			expect(index.generations).toHaveLength(1);
			expect(index.generations[0]).toMatchObject({
				generation: 0,
				agentId: "claude",
			});
		}
	});

	it("givenExistingSession_whenOpenSessionCalledWithExisting_thenIdempotentAndDoesNotOverwrite", async () => {
		// First open
		await openSession({
			workspaceId: "ws-1",
			taskId: "card-123",
			kind: "card",
			generation: 0,
			agentId: "claude",
			agentSessionId: "session-uuid-1",
			openedAt: 1000,
		});

		// Simulate updating manifest details externally
		const manifestPath = join(
			tempRoot,
			"home",
			"kanban",
			"workspaces",
			"ws-1",
			"sessions",
			"card-123",
			"0",
			"manifest.json",
		);
		const currentData = JSON.parse(await readFile(manifestPath, "utf8"));
		currentData.closedAt = 2000;
		currentData.outcome = "completed";
		await writeFile(manifestPath, JSON.stringify(currentData), "utf8");

		// Second open (idempotence test)
		const second = await openSession({
			workspaceId: "ws-1",
			taskId: "card-123",
			kind: "card",
			generation: 0,
			agentId: "claude",
			agentSessionId: "session-uuid-1",
			openedAt: 1000,
		});

		// Should retain modified values, not overwrite them with defaults!
		expect(second.closedAt).toBe(2000);
		expect(second.outcome).toBe("completed");
	});

	it("givenDiscoveredSessionId_whenOpenSessionCalledWithNullThenNonNull_thenNullUpdatedWithNonNull", async () => {
		// Opened with null session ID (discovery pending)
		const first = await openSession({
			workspaceId: "ws-1",
			taskId: "card-123",
			kind: "card",
			generation: 0,
			agentId: "claude",
			agentSessionId: null,
		});
		expect(first.agentSessionId).toBeNull();

		// Second open discovers the session ID
		const second = await openSession({
			workspaceId: "ws-1",
			taskId: "card-123",
			kind: "card",
			generation: 0,
			agentId: "claude",
			agentSessionId: "discovered-id-xyz",
		});
		expect(second.agentSessionId).toBe("discovered-id-xyz");
	});

	it("givenMissingIndex_whenListSessionsCalled_thenReconstructFromManifestDirs", async () => {
		// Let's create two generations manually on the filesystem
		const baseDir = join(tempRoot, "home", "kanban", "workspaces", "ws-1", "sessions", "card-123");
		await mkdir(join(baseDir, "0"), { recursive: true });
		await mkdir(join(baseDir, "1"), { recursive: true });

		const manifest0 = {
			schemaVersion: 1,
			taskId: "card-123",
			kind: "card",
			generation: 0,
			agentId: "claude",
			agentSessionId: "id-0",
			openedAt: 1000,
			closedAt: 1500,
			outcome: "completed",
			usage: {},
			source: {},
			body: {},
		};

		const manifest1 = {
			schemaVersion: 1,
			taskId: "card-123",
			kind: "card",
			generation: 1,
			agentId: "claude",
			agentSessionId: "id-1",
			openedAt: 2000,
			closedAt: null,
			outcome: "unknown",
			usage: {},
			source: {},
			body: {},
		};

		await writeFile(join(baseDir, "0", "manifest.json"), JSON.stringify(manifest0), "utf8");
		await writeFile(join(baseDir, "1", "manifest.json"), JSON.stringify(manifest1), "utf8");

		// Act - list sessions when index.json is completely missing!
		const index = await listSessions("ws-1", "card-123");

		expect(index).not.toBeNull();
		if (index) {
			expect(index.generations).toHaveLength(2);
			expect(index.generations[0]).toMatchObject({ generation: 0, openedAt: 1000, closedAt: 1500 });
			expect(index.generations[1]).toMatchObject({ generation: 1, openedAt: 2000, closedAt: null });
		}

		// Verify index.json was actually saved to disk as a self-healing step
		const indexContent = JSON.parse(await readFile(join(baseDir, "index.json"), "utf8"));
		expect(indexContent.generations).toHaveLength(2);
	});
});

describe("Session Ledger Harvest Migration", () => {
	it("givenHarvest_whenDryRun_thenNoFilesWrittenButReportsCorrectly", async () => {
		await writeWorkspaceIndex({ "ws-1": { repoPath: "/tmp/repo-1" } });
		await writeSessionsJson("ws-1", {
			"card-1": {
				taskId: "card-1",
				state: "idle",
				agentId: "claude",
				updatedAt: 123456,
				agentSessionId: "session-1",
			},
		});

		const results = await harvestSessions("ws-1", { dryRun: true });

		expect(results).toHaveLength(1);
		expect(results[0]).toEqual({
			workspaceId: "ws-1",
			taskId: "card-1",
			agentSessionId: "session-1",
			alreadyExisted: false,
			artifactPresent: false,
		});

		// Assert no manifest file was written
		const manifestPath = join(
			tempRoot,
			"home",
			"kanban",
			"workspaces",
			"ws-1",
			"sessions",
			"card-1",
			"0",
			"manifest.json",
		);
		await expect(readFile(manifestPath, "utf8")).rejects.toThrow();
	});

	it("givenHarvest_whenRunOnBoot_thenHarvestsBothCardsAndOverseersToGen0", async () => {
		await writeWorkspaceIndex({ "ws-1": { repoPath: "/tmp/repo-1" } });
		await writeSessionsJson("ws-1", {
			"card-1": {
				taskId: "card-1",
				state: "idle",
				agentId: "claude",
				updatedAt: 123456,
				agentSessionId: "session-1",
			},
			"__home_agent__:ws-1": {
				taskId: "__home_agent__:ws-1",
				state: "idle",
				agentId: "claude",
				updatedAt: 999999,
				agentSessionId: "home-session",
				homeAgentSessionGeneration: 2,
			},
		});

		const results = await harvestSessions("ws-1");

		expect(results).toHaveLength(2);

		// card-1 manifest assertions
		const cardManifest = JSON.parse(
			await readFile(
				join(tempRoot, "home", "kanban", "workspaces", "ws-1", "sessions", "card-1", "0", "manifest.json"),
				"utf8",
			),
		);
		expect(cardManifest).toMatchObject({
			schemaVersion: 1,
			taskId: "card-1",
			kind: "card",
			generation: 0,
			agentSessionId: "session-1",
			closedAt: 123456,
		});

		// overseer manifest assertions
		const overseerManifest = JSON.parse(
			await readFile(
				join(
					tempRoot,
					"home",
					"kanban",
					"workspaces",
					"ws-1",
					"sessions",
					"__home_agent__:ws-1",
					"2",
					"manifest.json",
				),
				"utf8",
			),
		);
		expect(overseerManifest).toMatchObject({
			schemaVersion: 1,
			taskId: "__home_agent__:ws-1",
			kind: "home-agent",
			generation: 2,
			agentSessionId: "home-session",
		});
	});

	it("givenUnreadableSessionsJson_whenHarvestRun_thenSkipsRatherThanWritesGarbage", async () => {
		await writeWorkspaceIndex({ "ws-1": { repoPath: "/tmp/repo-1" } });
		// Write invalid/corrupt JSON
		const workspaceDir = join(tempRoot, "home", "kanban", "workspaces", "ws-1");
		await mkdir(workspaceDir, { recursive: true });
		await writeFile(join(workspaceDir, "sessions.json"), "{ invalid }", "utf8");

		const results = await harvestSessions("ws-1");
		expect(results).toHaveLength(0);
	});

	it("givenNoAgentSessionId_whenHarvestRun_thenDoesNotHarvest", async () => {
		await writeWorkspaceIndex({ "ws-1": { repoPath: "/tmp/repo-1" } });
		await writeSessionsJson("ws-1", {
			"card-1": {
				taskId: "card-1",
				state: "idle",
				agentId: "claude",
				updatedAt: 123456,
				agentSessionId: null, // No agent session ID, should skip
			},
		});

		const results = await harvestSessions("ws-1");
		expect(results).toHaveLength(0);
	});

	it("givenSecondHarvest_whenRun_thenOnlyNewSessionAdded", async () => {
		await writeWorkspaceIndex({ "ws-1": { repoPath: "/tmp/repo-1" } });
		await writeSessionsJson("ws-1", {
			"card-1": {
				taskId: "card-1",
				state: "idle",
				agentId: "claude",
				updatedAt: 123456,
				agentSessionId: "session-1",
			},
		});

		// Clear the process guard first for this test so we simulate fresh state
		getHarvestedWorkspacesForTests().clear();

		// First harvest run
		const results1 = await harvestSessions("ws-1");
		expect(results1).toHaveLength(1);
		expect(results1[0].alreadyExisted).toBe(false);

		// Clear guard to allow a second harvest read of the same workspace ID for idempotency test
		getHarvestedWorkspacesForTests().clear();

		// Add a second card to sessions.json
		await writeSessionsJson("ws-1", {
			"card-1": {
				taskId: "card-1",
				state: "idle",
				agentId: "claude",
				updatedAt: 123456,
				agentSessionId: "session-1",
			},
			"card-2": {
				taskId: "card-2",
				state: "idle",
				agentId: "claude",
				updatedAt: 7891011,
				agentSessionId: "session-2",
			},
		});

		// Second harvest run
		const results2 = await harvestSessions("ws-1");
		// Should return results for both, but card-1 should have alreadyExisted: true
		expect(results2).toHaveLength(2);
		const c1 = results2.find((r) => r.taskId === "card-1");
		const c2 = results2.find((r) => r.taskId === "card-2");

		expect(c1).toBeDefined();
		expect(c2).toBeDefined();
		if (c1 && c2) {
			expect(c1.alreadyExisted).toBe(true);
			expect(c2.alreadyExisted).toBe(false);
		}
	});

	it("givenHarvest_whenCalledSecondTime_thenPerformsZeroFilesystemReads", async () => {
		await writeWorkspaceIndex({ "ws-1": { repoPath: "/tmp/repo-1" } });
		await writeSessionsJson("ws-1", {
			"card-1": {
				taskId: "card-1",
				state: "idle",
				agentId: "claude",
				updatedAt: 123456,
				agentSessionId: "session-1",
			},
		});

		// Spy on fsImpl.readFile
		const readFileSpy = vi.spyOn(fsImpl, "readFile");

		// First call should perform reads
		await harvestSessions("ws-1");
		const firstCallReadCount = readFileSpy.mock.calls.length;
		expect(firstCallReadCount).toBeGreaterThan(0);

		// Reset spy history
		readFileSpy.mockClear();

		// Second call (process-guarded)
		const results = await harvestSessions("ws-1");
		expect(results).toHaveLength(0); // Immediately returned [] due to process guard
		expect(readFileSpy).toHaveBeenCalledTimes(0); // ASSERT ZERO FILESYSTEM READS!

		readFileSpy.mockRestore();
	});
});
