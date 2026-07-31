import { promises as fs } from "node:fs";
import { join } from "node:path";

const rootDir = process.cwd();

async function walk(dir) {
	let files = [];
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const res = join(dir, entry.name);
			if (entry.isDirectory()) {
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
	const srcFiles = await walk(join(rootDir, "src"));
	const testFiles = await walk(join(rootDir, "test"));
	const allFiles = [...srcFiles, ...testFiles];

	let failed = false;

	for (const file of allFiles) {
		const relativePath = file.slice(rootDir.length + 1);

		// 1. Owning driver under src/agents/<id>/ is legal
		if (relativePath.startsWith("src/agents/")) {
			continue;
		}
		// 2. Declared test fixtures under test/fixtures/ are legal
		if (relativePath.startsWith("test/fixtures/")) {
			continue;
		}

		const content = await fs.readFile(file, "utf8");
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (
				line.includes('".claude"') ||
				line.includes('".codex"') ||
				line.includes('".gemini"') ||
				line.includes("'.claude'") ||
				line.includes("'.codex'") ||
				line.includes("'.gemini'") ||
				line.includes("`.claude`") ||
				line.includes("`.codex`") ||
				line.includes("`.gemini`")
			) {
				console.error(`[check-agent-paths] ERROR: Hand-rolled agent path literal found in non-driver / non-fixture file:`);
				console.error(`  File: ${relativePath}:${i + 1}`);
				console.error(`  Line: ${line.trim()}`);
				failed = true;
			}
		}
	}

	if (failed) {
		console.error(
			"\n[check-agent-paths] Validation failed. Test files must not construct agent path literals by hand. Use get*MockTranscriptPath helpers instead.",
		);
		process.exit(1);
	} else {
		console.log("[check-agent-paths] Success: No illegal hand-rolled agent path literals found.");
	}
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
