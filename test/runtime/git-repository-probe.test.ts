import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMocks = vi.hoisted(() => ({
	spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawnSync: childProcessMocks.spawnSync,
}));

import { probeGitRepository } from "../../src/core/git-repository-probe";

interface FakeSpawnResult {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
	signal: NodeJS.Signals | null;
}

function fakeSpawnResult(overrides: Partial<FakeSpawnResult>): FakeSpawnResult {
	return { status: 0, stdout: "", stderr: "", signal: null, ...overrides };
}

describe("probeGitRepository", () => {
	beforeEach(() => {
		childProcessMocks.spawnSync.mockReset();
	});

	it("reports yes when git confirms the path is inside a work tree", () => {
		childProcessMocks.spawnSync.mockReturnValue(fakeSpawnResult({ status: 0, stdout: "true\n" }));

		expect(probeGitRepository("/repo")).toBe("yes");
	});

	it("retries a transient non-zero exit and reports yes once git recovers", () => {
		childProcessMocks.spawnSync
			.mockReturnValueOnce(
				fakeSpawnResult({ status: 128, stderr: "fatal: Unable to read current working directory" }),
			)
			.mockReturnValueOnce(fakeSpawnResult({ status: 0, stdout: "true\n" }));

		expect(probeGitRepository("/repo")).toBe("yes");
		expect(childProcessMocks.spawnSync).toHaveBeenCalledTimes(2);
	});

	it("reports unknown when the git binary cannot be spawned", () => {
		childProcessMocks.spawnSync.mockReturnValue(
			fakeSpawnResult({
				status: null,
				error: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
			}),
		);

		expect(probeGitRepository("/repo")).toBe("unknown");
	});

	it("reports unknown when git is killed by a signal (e.g. a timeout)", () => {
		childProcessMocks.spawnSync.mockReturnValue(fakeSpawnResult({ status: null, signal: "SIGTERM" }));

		expect(probeGitRepository("/repo")).toBe("unknown");
	});

	it("reports unknown when a non-zero exit persists across retries without a verdict", () => {
		childProcessMocks.spawnSync.mockReturnValue(
			fakeSpawnResult({ status: 128, stderr: "fatal: Unable to read current working directory" }),
		);

		expect(probeGitRepository("/repo")).toBe("unknown");
		expect(childProcessMocks.spawnSync).toHaveBeenCalledTimes(2);
	});

	it("reports no only when git definitively says the path is not a repository", () => {
		childProcessMocks.spawnSync.mockReturnValue(
			fakeSpawnResult({
				status: 128,
				stderr: "fatal: not a git repository (or any of the parent directories): .git",
			}),
		);

		expect(probeGitRepository("/not-a-repo")).toBe("no");
		expect(childProcessMocks.spawnSync).toHaveBeenCalledTimes(1);
	});
});
