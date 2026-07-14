import { spawn } from "node:child_process";
import { clineHomeDir } from "../config/cline-home";
import type { RuntimeWorktreeConfig } from "../core/api-contract";

const DEFAULT_HOOK_TIMEOUT_MS = 300_000;
const DEFAULT_OUTPUT_TAIL_BYTES = 2048;
const KILL_GRACE_MS = 2000;

export interface WorktreePostCreateHookContext {
	taskId: string;
	workspaceId: string;
	worktreePath: string;
	repoPath: string;
	baseRef: string;
	clineHome?: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	outputTailBytes?: number;
}

export interface WorktreePostCreateHookResult {
	ok: boolean;
	exitCode: number | null;
	timedOut: boolean;
	outputTail: string;
}

export function buildWorktreeHookEnv(ctx: WorktreePostCreateHookContext): NodeJS.ProcessEnv {
	return {
		...process.env,
		...ctx.env,
		KANBAN_TASK_ID: ctx.taskId,
		KANBAN_WORKSPACE_ID: ctx.workspaceId,
		KANBAN_WORKTREE_PATH: ctx.worktreePath,
		KANBAN_REPO_PATH: ctx.repoPath,
		KANBAN_BASE_REF: ctx.baseRef,
		CLINE_HOME: ctx.clineHome ?? clineHomeDir(),
	};
}

function normalizeHookTimeoutMs(hook: RuntimeWorktreeConfig, ctx: WorktreePostCreateHookContext): number {
	const timeoutMs = ctx.timeoutMs ?? hook.postCreateTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
	return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : DEFAULT_HOOK_TIMEOUT_MS;
}

function trimOutputTail(output: string, capBytes: number): string {
	const cap = Number.isFinite(capBytes) && capBytes > 0 ? Math.floor(capBytes) : DEFAULT_OUTPUT_TAIL_BYTES;
	const bytes = Buffer.from(output, "utf8");
	if (bytes.byteLength <= cap) {
		return output;
	}
	return bytes
		.subarray(bytes.byteLength - cap)
		.toString("utf8")
		.replace(/^\uFFFD+/, "");
}

function resolveHookCommand(command: string | string[]): { file: string; args: string[] } | null {
	if (typeof command === "string") {
		const trimmed = command.trim();
		if (!trimmed) {
			return null;
		}
		if (process.platform === "win32") {
			return { file: "cmd.exe", args: ["/d", "/s", "/c", trimmed] };
		}
		return { file: "sh", args: ["-c", trimmed] };
	}
	const parts = command.map((part) => part.trim()).filter((part) => part.length > 0);
	if (parts.length === 0) {
		return null;
	}
	const [file, ...args] = parts;
	return file ? { file, args } : null;
}

function terminateProcessGroup(childPid: number): void {
	try {
		if (process.platform === "win32") {
			process.kill(childPid, "SIGTERM");
			return;
		}
		process.kill(-childPid, "SIGTERM");
	} catch {
		// Process may already have exited.
	}
}

function forceKillProcessGroup(childPid: number): void {
	try {
		if (process.platform === "win32") {
			process.kill(childPid, "SIGKILL");
			return;
		}
		process.kill(-childPid, "SIGKILL");
	} catch {
		// Process may already have exited.
	}
}

export async function runWorktreePostCreateHook(
	hook: RuntimeWorktreeConfig,
	ctx: WorktreePostCreateHookContext,
): Promise<WorktreePostCreateHookResult> {
	const command = hook.postCreateCommand;
	if (command === undefined) {
		return { ok: true, exitCode: 0, timedOut: false, outputTail: "" };
	}
	const resolved = resolveHookCommand(command);
	if (!resolved) {
		return { ok: true, exitCode: 0, timedOut: false, outputTail: "" };
	}

	const timeoutMs = normalizeHookTimeoutMs(hook, ctx);
	const outputTailBytes = ctx.outputTailBytes ?? DEFAULT_OUTPUT_TAIL_BYTES;

	return await new Promise<WorktreePostCreateHookResult>((resolve) => {
		let output = "";
		let timedOut = false;
		let settled = false;
		let forceKillTimer: NodeJS.Timeout | null = null;

		const child = spawn(resolved.file, resolved.args, {
			cwd: ctx.worktreePath,
			env: buildWorktreeHookEnv(ctx),
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		});

		const appendOutput = (chunk: Buffer | string) => {
			output = trimOutputTail(`${output}${chunk.toString()}`, outputTailBytes);
		};

		const timeout = setTimeout(() => {
			timedOut = true;
			if (child.pid !== undefined) {
				terminateProcessGroup(child.pid);
				forceKillTimer = setTimeout(() => {
					if (child.pid !== undefined) {
						forceKillProcessGroup(child.pid);
					}
				}, KILL_GRACE_MS);
			}
		}, timeoutMs);

		child.stdout?.on("data", appendOutput);
		child.stderr?.on("data", appendOutput);
		child.on("error", (error) => {
			appendOutput(error.message);
		});
		child.on("close", (exitCode) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			if (forceKillTimer !== null) {
				clearTimeout(forceKillTimer);
			}
			resolve({
				ok: !timedOut && exitCode === 0,
				exitCode,
				timedOut,
				outputTail: trimOutputTail(output, outputTailBytes),
			});
		});
	});
}
