import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { type CardTypeManifest, parseCardTypeManifest } from "../core/card-type";

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export async function resolveCanonicalCardTypesDir(options?: {
	moduleDir?: string;
	pathExists?: (path: string) => Promise<boolean>;
}): Promise<string | null> {
	const here = options?.moduleDir ?? dirname(fileURLToPath(import.meta.url));
	const exists = options?.pathExists ?? pathExists;
	const candidates = [
		resolve(here, "fleet/card-types"),
		resolve(here, "../fleet/card-types"),
		resolve(here, "../../fleet/card-types"),
	];
	for (const candidate of candidates) {
		if (await exists(candidate)) {
			return candidate;
		}
	}
	return null;
}

export async function loadCardTypeManifest(
	name: string,
	options: {
		workspacePath: string;
		moduleDir?: string;
		pathExists?: (path: string) => Promise<boolean>;
	},
): Promise<CardTypeManifest | null> {
	const exists = options?.pathExists ?? pathExists;

	// 1. Check Project layer first: <workspacePath>/fleet/card-types/<name>.md
	const projectPath = join(options.workspacePath, "fleet/card-types", `${name}.md`);
	if (await exists(projectPath)) {
		const content = await readFile(projectPath, "utf-8");
		const parsed = matter(content);
		return parseCardTypeManifest({
			name,
			...parsed.data,
		});
	}

	// 2. Check Built-in fallback layer: canonical card-types dir relative to this module
	const canonicalDir = await resolveCanonicalCardTypesDir({
		moduleDir: options.moduleDir,
		pathExists: exists,
	});
	if (canonicalDir) {
		const fallbackPath = join(canonicalDir, `${name}.md`);
		if (await exists(fallbackPath)) {
			const content = await readFile(fallbackPath, "utf-8");
			const parsed = matter(content);
			return parseCardTypeManifest({
				name,
				...parsed.data,
			});
		}
	}

	return null;
}
