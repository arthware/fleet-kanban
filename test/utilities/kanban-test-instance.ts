import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createGitTestEnv } from "./git-env";
import { createTempDir } from "./temp-dir";

const requireFromHere = createRequire(import.meta.url);

/**
 * Allocate a random free TCP port on the loopback interface.
 *
 * Every test server MUST bind an ephemeral port so parallel suites never race
 * for a fixed one — and so no test can accidentally collide with a live board
 * (e.g. the dogfood runtime on 3500 or a product board on 3484).
 */
export async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => {
			resolveListen();
		});
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : null;
	await new Promise<void>((resolveClose, rejectClose) => {
		server.close((error) => {
			if (error) {
				rejectClose(error);
				return;
			}
			resolveClose();
		});
	});
	if (!port) {
		throw new Error("Could not allocate a test port.");
	}
	return port;
}

export function resolveShutdownIpcHookPath(): string {
	return resolve(process.cwd(), "test/integration/shutdown-ipc-hook.cjs");
}

export function resolveTsxLoaderImportSpecifier(): string {
	return pathToFileURL(requireFromHere.resolve("tsx")).href;
}

function getShutdownSignal(): NodeJS.Signals {
	return process.platform === "win32" ? "SIGTERM" : "SIGINT";
}

/**
 * Ask the server child to shut down gracefully via the IPC channel installed by
 * `shutdown-ipc-hook.cjs`, falling back to a signal when IPC is unavailable.
 */
export async function requestGracefulShutdown(childProcess: ChildProcess): Promise<void> {
	if (typeof childProcess.send !== "function" || !childProcess.connected) {
		childProcess.kill(getShutdownSignal());
		return;
	}

	await new Promise<void>((resolveSend) => {
		childProcess.send({ type: "kanban.shutdown" }, (error) => {
			if (error) {
				childProcess.kill(getShutdownSignal());
			}
			resolveSend();
		});
	});
}

export async function waitForExit(childProcess: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (childProcess.exitCode !== null) {
		return true;
	}

	return await new Promise<boolean>((resolveExit) => {
		const handleExit = () => {
			clearTimeout(timeoutId);
			resolveExit(true);
		};
		const timeoutId = setTimeout(() => {
			childProcess.removeListener("exit", handleExit);
			resolveExit(false);
		}, timeoutMs);
		childProcess.once("exit", handleExit);
	});
}

export async function waitForProcessStart(
	childProcess: ChildProcess,
	timeoutMs = 10_000,
): Promise<{ runtimeUrl: string }> {
	return await new Promise((resolveStart, rejectStart) => {
		if (!childProcess.stdout || !childProcess.stderr) {
			rejectStart(new Error("Expected child process stdout/stderr pipes to be available."));
			return;
		}
		let settled = false;
		let stdout = "";
		let stderr = "";
		const timeoutId = setTimeout(() => {
			if (settled) {
				return;
			}
			settled = true;
			rejectStart(new Error(`Timed out waiting for server start.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
		}, timeoutMs);
		const handleOutput = (chunk: Buffer, source: "stdout" | "stderr") => {
			const text = chunk.toString();
			if (source === "stdout") {
				stdout += text;
			} else {
				stderr += text;
			}
			const match = stdout.match(/Cline Kanban running at (http:\/\/127\.0\.0\.1:\d+(?:\/[^\s]*)?)/);
			if (!match || settled) {
				return;
			}
			const runtimeUrl = match[1];
			if (!runtimeUrl) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			resolveStart({ runtimeUrl });
		};
		childProcess.stdout.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stdout");
		});
		childProcess.stderr.on("data", (chunk: Buffer) => {
			handleOutput(chunk, "stderr");
		});
		childProcess.once("exit", (code, signal) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeoutId);
			rejectStart(
				new Error(
					`Server process exited before startup (code=${String(code)} signal=${String(signal)}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
				),
			);
		});
	});
}

export interface StartKanbanServerInput {
	cwd: string;
	homeDir: string;
	port: number;
	extraArgs?: string[];
}

export interface KanbanServerHandle {
	runtimeUrl: string;
	stop: () => Promise<void>;
}

/**
 * Boot the real Kanban runtime server as a child process from source (via the
 * tsx loader), pointed at an isolated `homeDir`. The child inherits the current
 * environment with two safety adjustments: `GIT_*` overrides (so git commands
 * stay inside the test cwd) and a stripped `CLINE_HOME`, so the runtime resolves
 * its home under the throwaway `homeDir` rather than any inherited real board.
 */
export async function startKanbanServer(input: StartKanbanServerInput): Promise<KanbanServerHandle> {
	const cliEntrypoint = resolve(process.cwd(), "src/cli.ts");
	const shutdownIpcHookPath = resolveShutdownIpcHookPath();
	const tsxLoaderImportSpecifier = resolveTsxLoaderImportSpecifier();
	const env = createGitTestEnv({
		HOME: input.homeDir,
		USERPROFILE: input.homeDir,
		KANBAN_RUNTIME_PORT: String(input.port),
	});
	// Never let an inherited CLINE_HOME (e.g. from a dogfood shell) leak into the
	// child: that would resolve the runtime home to a real board. Stripping it
	// makes `clineHomeDir()` fall back to `homeDir/.cline`.
	delete env.CLINE_HOME;
	const child = spawn(
		process.execPath,
		[
			"--require",
			shutdownIpcHookPath,
			"--import",
			tsxLoaderImportSpecifier,
			cliEntrypoint,
			"--no-open",
			...(input.extraArgs ?? []),
		],
		{
			cwd: input.cwd,
			env,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	const { runtimeUrl } = await waitForProcessStart(child);
	return {
		runtimeUrl,
		stop: async () => {
			if (child.exitCode !== null) {
				return;
			}
			await requestGracefulShutdown(child);
			const didExitGracefully = await waitForExit(child, 5_000);
			if (didExitGracefully) {
				return;
			}

			child.kill("SIGKILL");
			const didExitAfterForce = await waitForExit(child, 5_000);
			if (!didExitAfterForce) {
				throw new Error("Timed out stopping kanban test server process.");
			}
		},
	};
}

export interface IsolatedKanbanInstanceOptions {
	cwd?: string;
	extraArgs?: string[];
}

export interface IsolatedKanbanInstance {
	baseUrl: string;
	port: number;
	homeDir: string;
	stop(): Promise<void>;
}

/**
 * Spin up ONE fully isolated Kanban runtime instance: a random free port, a
 * throwaway `CLINE_HOME`/`HOME`, and (unless `cwd` is provided) a throwaway
 * working directory. `stop()` shuts the server down gracefully and removes any
 * temp directories this helper created.
 */
export async function startIsolatedKanbanInstance(
	opts: IsolatedKanbanInstanceOptions = {},
): Promise<IsolatedKanbanInstance> {
	const port = await getAvailablePort();
	const home = createTempDir("kanban-isolated-home-");
	const workdir = opts.cwd ? null : createTempDir("kanban-isolated-cwd-");
	const cwd = opts.cwd ?? workdir?.path ?? process.cwd();

	let server: KanbanServerHandle;
	try {
		server = await startKanbanServer({
			cwd,
			homeDir: home.path,
			port,
			extraArgs: opts.extraArgs,
		});
	} catch (error) {
		workdir?.cleanup();
		home.cleanup();
		throw error;
	}

	return {
		baseUrl: server.runtimeUrl,
		port,
		homeDir: home.path,
		stop: async () => {
			try {
				await server.stop();
			} finally {
				workdir?.cleanup();
				home.cleanup();
			}
		},
	};
}
