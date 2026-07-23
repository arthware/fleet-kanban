import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface CaptureGeminiSessionIdInput {
	/** The task worktree the Gemini session was launched in. */
	readonly cwd: string;
	/** When the session started, used to ignore stale chat files. */
	readonly startedAtMs: number;
	/** Root of Gemini's temp files; defaults to `~/.gemini`. */
	readonly geminiRoot?: string;
}

const GEMINI_FILE_FRESH_WINDOW_MS = 10000; // 10 seconds tolerance for clock drift

/**
 * Maps a working directory (cwd) to its project-specific directory slug.
 * Reads the projects mapping file, then falls back to reading each folder's .project_root file.
 */
export async function findGeminiSlugForCwd(geminiRoot: string, cwd: string): Promise<string | null> {
	const normalizedCwd = resolve(cwd).replace(/[/\\]$/, "");

	// 1. Try ~/.gemini/projects.json
	const projectsJsonPath = join(geminiRoot, "projects.json");
	try {
		const content = await readFile(projectsJsonPath, "utf8");
		const data = JSON.parse(content);
		if (data && typeof data === "object" && data.projects && typeof data.projects === "object") {
			for (const [projPath, slug] of Object.entries(data.projects)) {
				if (typeof slug === "string" && resolve(projPath).replace(/[/\\]$/, "") === normalizedCwd) {
					return slug;
				}
			}
		}
	} catch {
		// Ignore and try fallback
	}

	// 2. Fallback to scanning ~/.gemini/tmp/*/
	const tmpRoot = join(geminiRoot, "tmp");
	try {
		const entries = await readdir(tmpRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const projectRootPath = join(tmpRoot, entry.name, ".project_root");
				try {
					const content = await readFile(projectRootPath, "utf8");
					if (resolve(content.trim()).replace(/[/\\]$/, "") === normalizedCwd) {
						return entry.name;
					}
				} catch {
					// Ignore subdirectory read errors
				}
			}
		}
	} catch {
		// Ignore root readdir errors
	}

	return null;
}

/**
 * Discover the session id of a freshly-spawned Gemini session by locating the
 * chats file that matches the task's cwd, then reading the id from its first line.
 * Returns null when no matching chats file has appeared yet.
 */
export async function captureGeminiSessionId(input: CaptureGeminiSessionIdInput): Promise<string | null> {
	const geminiRoot = input.geminiRoot ?? join(homedir(), ".gemini");
	const slug = await findGeminiSlugForCwd(geminiRoot, input.cwd);
	if (!slug) {
		return null;
	}

	const chatsDir = join(geminiRoot, "tmp", slug, "chats");
	let files: string[] = [];
	try {
		const entries = await readdir(chatsDir, { withFileTypes: true });
		files = entries
			.filter((e) => e.isFile() && e.name.startsWith("session-") && e.name.endsWith(".jsonl"))
			.map((e) => join(chatsDir, e.name));
	} catch {
		return null;
	}

	// Filter files by mtime and keep their details
	const filesWithMtime = [];
	for (const file of files) {
		try {
			const s = await stat(file);
			if (s.mtimeMs >= input.startedAtMs - GEMINI_FILE_FRESH_WINDOW_MS) {
				filesWithMtime.push({ file, mtimeMs: s.mtimeMs });
			}
		} catch {
			// Ignore read/stat errors for individual files
		}
	}

	// Sort files by mtime descending (newest first)
	filesWithMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

	if (filesWithMtime.length === 0) {
		return null;
	}

	// Read the first line of the newest fresh file
	const newestFile = filesWithMtime[0].file;
	try {
		const content = await readFile(newestFile, "utf8");
		const firstLine = content.split("\n")[0];
		const parsed = JSON.parse(firstLine);
		if (parsed && typeof parsed === "object" && typeof parsed.sessionId === "string") {
			return parsed.sessionId;
		}
	} catch {
		// Ignore parse/read errors
	}

	return null;
}
