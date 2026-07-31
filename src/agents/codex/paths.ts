import type { Dirent, Stats } from "node:fs";
import { realpathSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CODEX_ROLLOUT_FILE_FRESH_WINDOW_MS = 10 * 60 * 1000;
const CODEX_ROLLOUT_MATCH_SCAN_BYTES = 256 * 1024;
const MAX_CODEX_ROLLOUT_FILES_TO_SCAN = 100;

export function getCodexSessionsRoot(homePath: string = homedir()): string {
	return join(homePath, ".codex", "sessions");
}

export function normalizePathForComparison(path: string): string {
	return path.replaceAll("\\", "/");
}

export function encodedCwdCandidates(cwd: string): string[] {
	const candidates = new Set<string>();

	const addPath = (p: string) => {
		const norm = normalizePathForComparison(p);
		candidates.add(norm);
		if (norm.startsWith("/private/")) {
			candidates.add(norm.substring(8)); // without "/private"
		} else if (norm.startsWith("/var/")) {
			candidates.add(`/private${norm}`); // with "/private"
		}
	};

	addPath(cwd);
	try {
		addPath(realpathSync(cwd));
	} catch {
		// The worktree may be gone; the unresolved spelling is still worth matching.
	}
	return Array.from(candidates, (candidate) => `"cwd":${JSON.stringify(candidate)}`);
}

export async function readFilePrefix(filePath: string, byteLength: number): Promise<string> {
	if (byteLength <= 0) {
		return "";
	}
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(filePath, "r");
		const buffer = Buffer.alloc(byteLength);
		const readResult = await handle.read(buffer, 0, byteLength, 0);
		return buffer.subarray(0, readResult.bytesRead).toString("utf8");
	} finally {
		await handle?.close();
	}
}

export async function listCodexRolloutFiles(rootPath: string): Promise<string[]> {
	const stack = [rootPath];
	const files: string[] = [];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}

		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const entryPath = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(entryPath);
				continue;
			}
			if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
				files.push(entryPath);
			}
		}
	}

	files.sort((a, b) => b.localeCompare(a));
	return files;
}

export async function findCodexRolloutFileForCwd(
	cwd: string,
	sessionStartedAtMs: number,
	sessionsRoot: string,
): Promise<string | null> {
	if (!cwd.trim()) {
		return null;
	}
	const encodedCwds = encodedCwdCandidates(cwd);
	const rolloutFiles = (await listCodexRolloutFiles(sessionsRoot)).slice(0, MAX_CODEX_ROLLOUT_FILES_TO_SCAN);

	for (const filePath of rolloutFiles) {
		let fileStat: Stats;
		try {
			fileStat = await stat(filePath);
			if (fileStat.mtimeMs < sessionStartedAtMs - CODEX_ROLLOUT_FILE_FRESH_WINDOW_MS) {
				continue;
			}
		} catch {
			continue;
		}

		let prefix = "";
		try {
			prefix = await readFilePrefix(filePath, Math.min(fileStat.size, CODEX_ROLLOUT_MATCH_SCAN_BYTES));
		} catch {
			continue;
		}
		if (encodedCwds.some((encodedCwd) => prefix.includes(encodedCwd))) {
			return filePath;
		}
	}

	return null;
}
