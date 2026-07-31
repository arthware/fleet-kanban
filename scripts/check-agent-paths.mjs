import { promises as fs } from "node:fs";
import { join } from "node:path";

const rootDir = process.cwd();

export function checkContent(content, relativePath) {
	// 1. Owning driver under src/agents/<id>/ is legal
	if (relativePath.startsWith("src/agents/")) {
		return [];
	}
	// 2. Declared test fixtures under test/fixtures/ are legal
	if (relativePath.startsWith("test/fixtures/")) {
		return [];
	}
	// 3. The checker's own test suite is allowed to contain match patterns for testing
	if (relativePath.endsWith("check-agent-paths.test.ts")) {
		return [];
	}

	const errors = [];
	const lines = content.split("\n");
	let inBlockComment = false;

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];

		// Handle block comments
		if (inBlockComment) {
			const endIdx = line.indexOf("*/");
			if (endIdx !== -1) {
				inBlockComment = false;
				line = line.slice(endIdx + 2);
			} else {
				continue; // Skip whole line
			}
		}

		const startIdx = line.indexOf("/*");
		if (startIdx !== -1) {
			const endIdx = line.indexOf("*/", startIdx + 2);
			if (endIdx !== -1) {
				line = line.slice(0, startIdx) + line.slice(endIdx + 2);
			} else {
				inBlockComment = true;
				line = line.slice(0, startIdx);
			}
		}

		// Strip single line comments
		const commentIdx = line.indexOf("//");
		if (commentIdx !== -1) {
			line = line.slice(0, commentIdx);
		}

		// Match agent directory segment in strings, templates, or path variables
		// Matches .claude, .codex, or .gemini when followed by a slash, quote, backtick, or end-of-line
		const match = line.match(/\.(claude|codex|gemini)(['"`\/]|$)/);
		if (match) {
			errors.push({
				line: i + 1,
				text: lines[i].trim(),
			});
		}
	}

	return errors;
}

async function walk(dir) {
	let files = [];
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const res = join(dir, entry.name);
			if (entry.isDirectory()) {
				// Avoid walking node_modules or .worktrees
				if (entry.name === "node_modules" || entry.name === ".worktrees" || entry.name === "dist") {
					continue;
				}
				files = files.concat(await walk(res));
			} else if (
				entry.isFile() &&
				(res.endsWith(".ts") || res.endsWith(".tsx") || res.endsWith(".js") || res.endsWith(".mjs"))
			) {
				files.push(res);
			}
		}
	} catch {
		// Directory may not exist
	}
	return files;
}

async function run() {
	// Only run walk-and-check if this script is invoked directly as a process (not imported in tests)
	if (process.argv[1] && process.argv[1].endsWith("check-agent-paths.mjs")) {
		const scanDirs = [
			join(rootDir, "src"),
			join(rootDir, "test"),
			join(rootDir, "web-ui/src"),
			join(rootDir, "web-ui/tests"),
		];

		let allFiles = [];
		for (const dir of scanDirs) {
			allFiles = allFiles.concat(await walk(dir));
		}

		let failed = false;

		for (const file of allFiles) {
			const relativePath = file.slice(rootDir.length + 1);
			const content = await fs.readFile(file, "utf8");
			const errors = checkContent(content, relativePath);

			if (errors.length > 0) {
				for (const error of errors) {
					console.error(
						`[check-agent-paths] ERROR: Hand-rolled agent path literal found in non-driver / non-fixture file:`,
					);
					console.error(`  File: ${relativePath}:${error.line}`);
					console.error(`  Line: ${error.text}`);
				}
				failed = true;
			}
		}

		if (failed) {
			console.error(
				"\n[check-agent-paths] Validation failed. Test and source files must not construct agent path literals by hand. Use get*MockTranscriptPath helpers instead.",
			);
			process.exit(1);
		} else {
			console.log("[check-agent-paths] Success: No illegal hand-rolled agent path literals found.");
		}
	}
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
