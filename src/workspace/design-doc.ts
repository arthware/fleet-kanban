import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RuntimeDesignDocResponse, RuntimeTaskFileResponse } from "../core/api-contract";
import { resolveDesignDocRefCandidates } from "../core/task-ref";
import { resolveTaskCwd } from "./task-worktree";

const DEFAULT_TASK_FILE_MAX_BYTES = 1024 * 1024;
const BINARY_SAMPLE_BYTES = 8192;

export async function readTaskDesignDoc(input: {
	projectRoot: string;
	taskId: string;
	externalIssueKey?: string;
}): Promise<RuntimeDesignDocResponse> {
	const designDir = join(input.projectRoot, "docs", "design");
	let entries: string[];
	try {
		entries = await readdir(designDir);
	} catch {
		return { exists: false };
	}

	for (const ref of resolveDesignDocRefCandidates(input)) {
		const prefix = `${ref}-`;
		const match = entries
			.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".md"))
			.sort((left, right) => left.localeCompare(right))[0];
		if (!match) {
			continue;
		}
		const path = join(designDir, match);
		try {
			const content = await readFile(path, "utf8");
			return { exists: true, path, content };
		} catch {
			return { exists: false };
		}
	}
	return { exists: false };
}

function assertRelativeTaskFilePath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed || isAbsolute(trimmed)) {
		throw new Error("Invalid task file path.");
	}
	const normalized = trimmed.replaceAll("\\", "/");
	if (normalized.split("/").some((segment) => segment === "..")) {
		throw new Error("Invalid task file path.");
	}
	return normalized;
}

function isPathWithinRoot(path: string, root: string): boolean {
	const relativePath = relative(root, path);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

async function isBinaryFile(path: string): Promise<boolean> {
	const file = await open(path, "r");
	try {
		const buffer = Buffer.alloc(BINARY_SAMPLE_BYTES);
		const result = await file.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, result.bytesRead).includes(0);
	} finally {
		await file.close();
	}
}

export async function readFileWithinRoot(input: {
	root: string;
	path: string;
	maxBytes?: number;
}): Promise<RuntimeTaskFileResponse> {
	const relativePath = assertRelativeTaskFilePath(input.path);
	const realRoot = await realpath(input.root);
	const candidatePath = resolve(realRoot, relativePath);
	if (!isPathWithinRoot(candidatePath, realRoot)) {
		throw new Error("Task file path escapes the worktree.");
	}

	let realFilePath: string;
	try {
		realFilePath = await realpath(candidatePath);
	} catch {
		return { exists: false, path: relativePath };
	}
	if (!isPathWithinRoot(realFilePath, realRoot)) {
		throw new Error("Task file path escapes the worktree.");
	}

	const fileStat = await stat(realFilePath);
	if (!fileStat.isFile()) {
		return { exists: false, path: relativePath };
	}

	const maxBytes = input.maxBytes ?? DEFAULT_TASK_FILE_MAX_BYTES;
	if (fileStat.size > maxBytes) {
		return { exists: true, path: relativePath, tooLarge: true, sizeBytes: fileStat.size };
	}
	if (await isBinaryFile(realFilePath)) {
		return { exists: true, path: relativePath, binary: true, sizeBytes: fileStat.size };
	}

	const content = await readFile(realFilePath, "utf8");
	return {
		exists: true,
		path: relative(realRoot, realFilePath).split(sep).join("/"),
		content,
		sizeBytes: fileStat.size,
	};
}

export async function readFileWithinTaskWorktree(input: {
	projectRoot: string;
	taskId: string;
	baseRef: string;
	path: string;
	maxBytes?: number;
}): Promise<RuntimeTaskFileResponse> {
	const worktreeRoot = await resolveTaskCwd({
		cwd: input.projectRoot,
		taskId: input.taskId,
		baseRef: input.baseRef,
		ensure: false,
	});
	return await readFileWithinRoot({
		root: worktreeRoot,
		path: input.path,
		maxBytes: input.maxBytes,
	});
}
