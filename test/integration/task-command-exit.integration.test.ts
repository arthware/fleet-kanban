import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import { createGitTestEnv } from "../utilities/git-env";
import {
	getAvailablePort,
	requestGracefulShutdown,
	resolveShutdownIpcHookPath,
	resolveTsxLoaderImportSpecifier,
	waitForExit,
	waitForProcessStart as waitForServerStart,
} from "../utilities/kanban-test-instance";
import { createTempDir } from "../utilities/temp-dir";

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
	const checkout = spawnSync("git", ["checkout", "-B", "main"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (checkout.status !== 0) {
		throw new Error(`Failed to create main branch at ${path}`);
	}
}

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function commitAll(cwd: string, message: string): string {
	runGit(cwd, ["add", "."]);
	runGit(cwd, ["commit", "-qm", message]);
	return runGit(cwd, ["rev-parse", "HEAD"]);
}

async function withHomeEnv<T>(homeDir: string, run: () => Promise<T>): Promise<T> {
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = homeDir;
	process.env.USERPROFILE = homeDir;
	try {
		return await run();
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
	}
}

function installBrowserOpenStub(binDir: string, logPath: string): void {
	mkdirSync(binDir, { recursive: true });
	const script = `#!/usr/bin/env sh
printf '%s\n' "$*" >> ${JSON.stringify(logPath)}
`;
	const commandNames = process.platform === "darwin" ? ["open"] : ["xdg-open"];
	for (const commandName of commandNames) {
		const scriptPath = join(binDir, commandName);
		writeFileSync(scriptPath, script, "utf8");
		chmodSync(scriptPath, 0o755);
	}
}

function installFakeClaudeStub(binDir: string): void {
	mkdirSync(binDir, { recursive: true });
	const scriptPath = join(binDir, "claude");
	const script = `#!/usr/bin/env sh
printf 'fake claude started\\n'
sleep 30
`;
	writeFileSync(scriptPath, script, "utf8");
	chmodSync(scriptPath, 0o755);
}

function readBrowserOpenLog(logPath: string): string[] {
	if (!existsSync(logPath)) {
		return [];
	}
	return readFileSync(logPath, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

async function waitForBrowserOpenCount(logPath: string, expectedCount: number, timeoutMs = 2_000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (readBrowserOpenLog(logPath).length >= expectedCount) {
			return;
		}
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 25);
		});
	}
	throw new Error(
		`Timed out waiting for browser open count ${expectedCount}. Current log: ${readBrowserOpenLog(logPath).join(", ")}`,
	);
}

function spawnSourceCli(
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdio?: ChildProcess["stdio"] },
) {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	return spawn(process.execPath, ["--import", resolveTsxLoaderImportSpecifier(), cliEntrypoint, ...args], {
		cwd: options.cwd,
		env: options.env,
		stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
	});
}

async function runCliCommandAndCollectOutput(options: {
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; didExit: boolean }> {
	const process = spawnSourceCli(options.args, {
		cwd: options.cwd,
		env: options.env,
	});

	let stdout = "";
	let stderr = "";
	process.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	process.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	const didExit = await waitForExit(process, options.timeoutMs ?? 8_000);
	if (!didExit) {
		process.kill("SIGKILL");
	}

	return {
		stdout,
		stderr,
		exitCode: process.exitCode,
		didExit,
	};
}

describe("source task commands", () => {
	it("exits after creating a task when the runtime server is already running", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-exit-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-exit-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Exit Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const commandProcess = spawnSourceCli(
					[
						"task",
						"create",
						"--prompt",
						"Add a demo banner component to the homepage that displays a welcome message and current weather summary",
						"--project-path",
						projectPath,
					],
					{
						cwd: projectPath,
						env,
					},
				);

				let stdout = "";
				let stderr = "";
				commandProcess.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString();
				});
				commandProcess.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString();
				});

				const didExit = await waitForExit(commandProcess, 8_000);
				if (!didExit) {
					commandProcess.kill("SIGKILL");
				}

				expect(didExit, `task create did not exit in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(true);
				expect(commandProcess.exitCode).toBe(0);
				expect(stdout).toContain('"ok": true');
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("opens only for launch invocations", { timeout: 60_000 }, async () => {
		if (process.platform === "win32") {
			return;
		}

		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-root-launch-open-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-root-launch-open-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Root Launch Browser Open Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const browserStubBinDir = join(homeDir, "browser-bin");
			const browserOpenLogPath = join(homeDir, "browser-open.log");
			installBrowserOpenStub(browserStubBinDir, browserOpenLogPath);
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
				PATH: `${browserStubBinDir}:${process.env.PATH ?? ""}`,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				for (const [args, expectedOpenCount] of [
					[[], 1],
					[["task", "list", "--project-path", projectPath], 1],
					[["--agent", "codex"], 2],
					[["--port", port], 3],
				] as const) {
					const result = await runCliCommandAndCollectOutput({
						args: [...args],
						cwd: projectPath,
						env,
					});
					expect(result.didExit).toBe(true);
					expect(result.exitCode).toBe(0);
					await waitForBrowserOpenCount(browserOpenLogPath, expectedOpenCount);
					expect(readBrowserOpenLog(browserOpenLogPath)).toHaveLength(expectedOpenCount);
				}
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("keeps done, trash, and delete as separate task lifecycles", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-done-delete-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-done-delete-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Done Delete Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const taskIds: string[] = [];
				for (const prompt of [
					"Create a temporary task for done and delete",
					"Create another temporary task for done and delete",
					"Create a legacy trash command task for done and delete",
				]) {
					const created = await runCliCommandAndCollectOutput({
						args: ["task", "create", "--prompt", prompt, "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(
						created.didExit,
						`task create did not exit in time.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
					).toBe(true);
					expect(created.exitCode).toBe(0);

					const createdPayload = JSON.parse(created.stdout) as {
						ok?: boolean;
						task?: { id?: string };
					};
					expect(createdPayload.ok).toBe(true);
					expect(typeof createdPayload.task?.id).toBe("string");
					if (createdPayload.task?.id) {
						taskIds.push(createdPayload.task.id);
					}
				}
				expect(taskIds).toHaveLength(3);

				const doneWorktreePath = await withHomeEnv(homeDir, async () => {
					const ensured = await ensureTaskWorktreeIfDoesntExist({
						cwd: projectPath,
						taskId: taskIds[0] ?? "",
						baseRef: "main",
					});
					if (!ensured.ok) {
						throw new Error(ensured.error ?? "Could not ensure done task worktree.");
					}
					return ensured.path;
				});
				const trashWorktreePath = await withHomeEnv(homeDir, async () => {
					const ensured = await ensureTaskWorktreeIfDoesntExist({
						cwd: projectPath,
						taskId: taskIds[1] ?? "",
						baseRef: "main",
					});
					if (!ensured.ok) {
						throw new Error(ensured.error ?? "Could not ensure trash task worktree.");
					}
					return ensured.path;
				});
				expect(existsSync(doneWorktreePath)).toBe(true);
				expect(existsSync(trashWorktreePath)).toBe(true);

				const movedToDone = await runCliCommandAndCollectOutput({
					args: ["task", "done", "--task-id", taskIds[0] ?? "", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					movedToDone.didExit,
					`task done did not exit in time.\nstdout:\n${movedToDone.stdout}\nstderr:\n${movedToDone.stderr}`,
				).toBe(true);
				expect(movedToDone.exitCode).toBe(0);
				expect(movedToDone.stdout).toContain('"ok": true');
				expect(existsSync(doneWorktreePath)).toBe(true);

				const movedByTrashCommand = await runCliCommandAndCollectOutput({
					args: ["task", "trash", "--column", "backlog", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					movedByTrashCommand.didExit,
					`task trash did not exit in time.\nstdout:\n${movedByTrashCommand.stdout}\nstderr:\n${movedByTrashCommand.stderr}`,
				).toBe(true);
				expect(movedByTrashCommand.exitCode).toBe(0);
				expect(movedByTrashCommand.stdout).toContain('"ok": true');
				expect(movedByTrashCommand.stdout).toContain('"column": "backlog"');
				expect(movedByTrashCommand.stdout).toContain('"count": 2');
				expect(existsSync(trashWorktreePath)).toBe(false);

				const listedDoneBeforeDelete = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "done", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					listedDoneBeforeDelete.didExit,
					`task list --column done did not exit in time.\nstdout:\n${listedDoneBeforeDelete.stdout}\nstderr:\n${listedDoneBeforeDelete.stderr}`,
				).toBe(true);
				expect(listedDoneBeforeDelete.exitCode).toBe(0);
				expect(listedDoneBeforeDelete.stdout).toContain('"count": 1');

				const listedTrashBeforeDelete = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "trash", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					listedTrashBeforeDelete.didExit,
					`task list --column trash did not exit in time.\nstdout:\n${listedTrashBeforeDelete.stdout}\nstderr:\n${listedTrashBeforeDelete.stderr}`,
				).toBe(true);
				expect(listedTrashBeforeDelete.exitCode).toBe(0);
				expect(listedTrashBeforeDelete.stdout).toContain('"count": 2');

				const deletedDone = await runCliCommandAndCollectOutput({
					args: ["task", "delete", "--column", "done", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					deletedDone.didExit,
					`task delete --column done did not exit in time.\nstdout:\n${deletedDone.stdout}\nstderr:\n${deletedDone.stderr}`,
				).toBe(true);
				expect(deletedDone.exitCode).toBe(0);
				expect(deletedDone.stdout).toContain('"ok": true');
				expect(deletedDone.stdout).toContain('"column": "done"');
				expect(deletedDone.stdout).toContain('"count": 1');
				expect(existsSync(doneWorktreePath)).toBe(false);

				const listedTrash = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "trash", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					listedTrash.didExit,
					`task list --column trash did not exit in time.\nstdout:\n${listedTrash.stdout}\nstderr:\n${listedTrash.stderr}`,
				).toBe(true);
				expect(listedTrash.exitCode).toBe(0);
				expect(listedTrash.stdout).toContain('"count": 2');
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("treats create-time reasoning inherit as no explicit override", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-cline-reasoning-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-cline-reasoning-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Cline Reasoning Test\n", "utf8");
			commitAll(projectPath, "init");

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const inheritedCreate = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--prompt",
						"Create a task that inherits workspace reasoning",
						"--project-path",
						projectPath,
						"--cline-reasoning-effort",
						"inherit",
					],
					cwd: projectPath,
					env,
				});
				expect(inheritedCreate.didExit).toBe(true);
				expect(inheritedCreate.exitCode).toBe(0);

				const inheritedPayload = JSON.parse(inheritedCreate.stdout) as {
					ok?: boolean;
					task?: { clineSettings?: Record<string, unknown> };
				};
				expect(inheritedPayload.ok).toBe(true);
				expect(inheritedPayload.task?.clineSettings).toBeUndefined();

				const defaultCreate = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--prompt",
						"Create a task that uses model default reasoning",
						"--project-path",
						projectPath,
						"--cline-reasoning-effort",
						"default",
					],
					cwd: projectPath,
					env,
				});
				expect(defaultCreate.didExit).toBe(true);
				expect(defaultCreate.exitCode).toBe(0);

				const defaultPayload = JSON.parse(defaultCreate.stdout) as {
					ok?: boolean;
					task?: { clineSettings?: Record<string, unknown> };
				};
				expect(defaultPayload.ok).toBe(true);
				expect(defaultPayload.task?.clineSettings).toEqual({});
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it(
		"updates and clears a backlog task's agent model, and rejects the override once the task leaves backlog",
		{ timeout: 60_000 },
		async () => {
			const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-agent-model-");
			const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-agent-model-");

			try {
				initGitRepository(projectPath);
				writeFileSync(join(projectPath, "README.md"), "# Task Agent Model Test\n", "utf8");
				commitAll(projectPath, "init");

				const port = String(await getAvailablePort());
				const env = createGitTestEnv({
					HOME: homeDir,
					USERPROFILE: homeDir,
					KANBAN_RUNTIME_PORT: port,
				});

				const serverProcess = spawn(
					process.execPath,
					[
						"--require",
						resolveShutdownIpcHookPath(),
						"--import",
						resolveTsxLoaderImportSpecifier(),
						resolve(process.cwd(), "src/cli.ts"),
						"--no-open",
					],
					{
						cwd: projectPath,
						env,
						stdio: ["ignore", "pipe", "pipe", "ipc"],
					},
				);

				try {
					await waitForServerStart(serverProcess);

					const created = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"create",
							"--prompt",
							"Create a task whose agent model gets updated",
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(created.exitCode).toBe(0);
					const createdPayload = JSON.parse(created.stdout) as { ok?: boolean; task?: { id?: string } };
					const taskId = createdPayload.task?.id ?? "";
					expect(taskId).not.toBe("");

					const updatedWithModel = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"update",
							"--task-id",
							taskId,
							"--agent-model",
							"claude-haiku-4-5",
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(
						updatedWithModel.exitCode,
						`task update --agent-model failed.\nstdout:\n${updatedWithModel.stdout}\nstderr:\n${updatedWithModel.stderr}`,
					).toBe(0);
					const updatedPayload = JSON.parse(updatedWithModel.stdout) as {
						ok?: boolean;
						task?: { agentModel?: string };
					};
					expect(updatedPayload.task?.agentModel).toBe("claude-haiku-4-5");

					const listed = await runCliCommandAndCollectOutput({
						args: ["task", "list", "--column", "backlog", "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(listed.exitCode).toBe(0);
					expect(listed.stdout).toContain('"agentModel": "claude-haiku-4-5"');

					const clearedModel = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"update",
							"--task-id",
							taskId,
							"--agent-model",
							"default",
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(clearedModel.exitCode).toBe(0);
					const clearedPayload = JSON.parse(clearedModel.stdout) as { task?: { agentModel?: string } };
					expect(clearedPayload.task?.agentModel).toBeUndefined();

					const trashed = await runCliCommandAndCollectOutput({
						args: ["task", "trash", "--task-id", taskId, "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(trashed.exitCode).toBe(0);

					const rejectedUpdate = await runCliCommandAndCollectOutput({
						args: [
							"task",
							"update",
							"--task-id",
							taskId,
							"--agent-model",
							"claude-haiku-4-5",
							"--project-path",
							projectPath,
						],
						cwd: projectPath,
						env,
					});
					expect(rejectedUpdate.exitCode).not.toBe(0);
					expect(rejectedUpdate.stdout).toContain("can only be changed while a task is in backlog");
				} finally {
					await requestGracefulShutdown(serverProcess);
					const stopped = await waitForExit(serverProcess, 5_000);
					if (!stopped) {
						serverProcess.kill("SIGKILL");
						await waitForExit(serverProcess, 5_000);
					}
				}
			} finally {
				cleanupProject();
				cleanupHome();
			}
		},
	);

	it("creates, updates, and clears external issue metadata through the task CLI", { timeout: 60_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-external-issue-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-external-issue-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task External Issue Test\n", "utf8");
			commitAll(projectPath, "init");
			runGit(projectPath, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);

			const port = String(await getAvailablePort());
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const created = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"create",
						"--prompt",
						"Create a task with an external issue",
						"--issue",
						"owner/repo#42",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(
					created.exitCode,
					`task create failed.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
				).toBe(0);
				const createdPayload = JSON.parse(created.stdout) as {
					task?: { id?: string; externalIssue?: { key?: string; url?: string; raw?: string } };
				};
				const taskId = createdPayload.task?.id ?? "";
				expect(taskId).not.toBe("");
				expect(createdPayload.task?.externalIssue).toEqual({
					provider: "github",
					key: "owner/repo#42",
					url: "https://github.com/owner/repo/issues/42",
					raw: "owner/repo#42",
				});

				const updatedToUnlinkedLinear = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"update",
						"--task-id",
						taskId,
						"--external-issue",
						"ENG-123",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(updatedToUnlinkedLinear.exitCode).toBe(0);
				const linearPayload = JSON.parse(updatedToUnlinkedLinear.stdout) as {
					task?: { externalIssue?: { provider?: string; key?: string; url?: string; raw?: string } };
				};
				expect(linearPayload.task?.externalIssue).toEqual({
					provider: "linear",
					key: "ENG-123",
					raw: "ENG-123",
				});

				const trashed = await runCliCommandAndCollectOutput({
					args: ["task", "trash", "--task-id", taskId, "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(trashed.exitCode).toBe(0);

				const updatedOutsideBacklog = await runCliCommandAndCollectOutput({
					args: ["task", "update", "--task-id", taskId, "--external-issue", "#7", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(updatedOutsideBacklog.exitCode).toBe(0);
				const outsideBacklogPayload = JSON.parse(updatedOutsideBacklog.stdout) as {
					task?: { externalIssue?: { key?: string; url?: string; raw?: string } };
				};
				expect(outsideBacklogPayload.task?.externalIssue).toEqual({
					provider: "github",
					key: "#7",
					url: "https://github.com/owner/repo/issues/7",
					raw: "#7",
				});

				const cleared = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"update",
						"--task-id",
						taskId,
						"--external-issue",
						"default",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(cleared.exitCode).toBe(0);
				const clearedPayload = JSON.parse(cleared.stdout) as { task?: { externalIssue?: unknown } };
				expect(clearedPayload.task?.externalIssue).toBeUndefined();
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});

	it("accepts external issue keys anywhere a single task id is accepted", { timeout: 90_000 }, async () => {
		const { path: homeDir, cleanup: cleanupHome } = createTempDir("kanban-home-task-issue-ref-");
		const { path: projectPath, cleanup: cleanupProject } = createTempDir("kanban-project-task-issue-ref-");

		try {
			initGitRepository(projectPath);
			writeFileSync(join(projectPath, "README.md"), "# Task Issue Ref Test\n", "utf8");
			commitAll(projectPath, "init");
			runGit(projectPath, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);

			const port = String(await getAvailablePort());
			const fakeAgentBinDir = join(homeDir, "agent-bin");
			installFakeClaudeStub(fakeAgentBinDir);
			const env = createGitTestEnv({
				HOME: homeDir,
				USERPROFILE: homeDir,
				KANBAN_RUNTIME_PORT: port,
				PATH: `${fakeAgentBinDir}:${process.env.PATH ?? ""}`,
			});

			const serverProcess = spawn(
				process.execPath,
				[
					"--require",
					resolveShutdownIpcHookPath(),
					"--import",
					resolveTsxLoaderImportSpecifier(),
					resolve(process.cwd(), "src/cli.ts"),
					"--no-open",
				],
				{
					cwd: projectPath,
					env,
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);

			try {
				await waitForServerStart(serverProcess);

				const createIssueTask = async (prompt: string, issue: string): Promise<string> => {
					const created = await runCliCommandAndCollectOutput({
						args: ["task", "create", "--prompt", prompt, "--issue", issue, "--project-path", projectPath],
						cwd: projectPath,
						env,
					});
					expect(
						created.exitCode,
						`task create failed.\nstdout:\n${created.stdout}\nstderr:\n${created.stderr}`,
					).toBe(0);
					const payload = JSON.parse(created.stdout) as { task?: { id?: string } };
					expect(payload.task?.id).toEqual(expect.any(String));
					return payload.task?.id ?? "";
				};

				const startTaskId = await createIssueTask("Task addressed by Linear start key", "ENG-101");
				const updateTaskId = await createIssueTask("Task addressed by Linear update key", "ENG-102");
				await createIssueTask("Task addressed by owner repo done key", "owner/repo#103");
				await createIssueTask("Task addressed by short GitHub trash key", "#104");
				await createIssueTask("Task addressed by Linear delete key", "ENG-105");
				const linkTaskId = await createIssueTask("Task addressed by Linear link key", "ENG-106");
				const linkedTaskId = await createIssueTask("Task addressed by short GitHub linked key", "#107");
				await createIssueTask("First ambiguous task", "ENG-108");
				await createIssueTask("Second ambiguous task", "ENG-108");

				const startByIssue = await runCliCommandAndCollectOutput({
					args: ["task", "start", "--task-id", "ENG-101", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(
					startByIssue.exitCode,
					`task start by issue failed.\nstdout:\n${startByIssue.stdout}\nstderr:\n${startByIssue.stderr}`,
				).toBe(0);
				expect(startByIssue.stdout).toContain(`"id": "${startTaskId}"`);
				expect(startByIssue.stdout).toContain('"column": "in_progress"');

				const updateByIssue = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"update",
						"--task-id",
						"ENG-102",
						"--prompt",
						"Updated through issue key",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(updateByIssue.exitCode).toBe(0);
				expect(updateByIssue.stdout).toContain(`"id": "${updateTaskId}"`);
				expect(updateByIssue.stdout).toContain('"prompt": "Updated through issue key"');

				const updateByRealId = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"update",
						"--task-id",
						updateTaskId,
						"--prompt",
						"Updated through real id",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(updateByRealId.exitCode).toBe(0);
				expect(updateByRealId.stdout).toContain(`"id": "${updateTaskId}"`);
				expect(updateByRealId.stdout).toContain('"prompt": "Updated through real id"');

				const doneByIssue = await runCliCommandAndCollectOutput({
					args: ["task", "done", "--task-id", "owner/repo#103", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(doneByIssue.exitCode).toBe(0);
				expect(doneByIssue.stdout).toContain('"column": "done"');

				const trashByIssue = await runCliCommandAndCollectOutput({
					args: ["task", "trash", "--task-id", "#104", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(trashByIssue.exitCode).toBe(0);
				expect(trashByIssue.stdout).toContain('"column": "trash"');

				const deleteByIssue = await runCliCommandAndCollectOutput({
					args: ["task", "delete", "--task-id", "ENG-105", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(deleteByIssue.exitCode).toBe(0);
				expect(deleteByIssue.stdout).toContain('"count": 1');

				const linkByIssues = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"link",
						"--task-id",
						"ENG-106",
						"--linked-task-id",
						"#107",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(linkByIssues.exitCode).toBe(0);
				expect(linkByIssues.stdout).toContain(`"backlogTaskId": "${linkTaskId}"`);
				expect(linkByIssues.stdout).toContain(`"linkedTaskId": "${linkedTaskId}"`);

				const ambiguousUpdate = await runCliCommandAndCollectOutput({
					args: [
						"task",
						"update",
						"--task-id",
						"ENG-108",
						"--prompt",
						"Should not be applied",
						"--project-path",
						projectPath,
					],
					cwd: projectPath,
					env,
				});
				expect(ambiguousUpdate.exitCode).not.toBe(0);
				const ambiguousPayload = JSON.parse(ambiguousUpdate.stdout) as { error?: string };
				expect(ambiguousPayload.error).toContain('Multiple cards reference issue "ENG-108":');

				const listed = await runCliCommandAndCollectOutput({
					args: ["task", "list", "--column", "backlog", "--project-path", projectPath],
					cwd: projectPath,
					env,
				});
				expect(listed.exitCode).toBe(0);
				expect(listed.stdout).not.toContain("Should not be applied");
			} finally {
				await requestGracefulShutdown(serverProcess);
				const stopped = await waitForExit(serverProcess, 5_000);
				if (!stopped) {
					serverProcess.kill("SIGKILL");
					await waitForExit(serverProcess, 5_000);
				}
			}
		} finally {
			cleanupProject();
			cleanupHome();
		}
	});
});
