import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SkillSourceLayerKind = "project" | "bundled";

export interface SkillSourceLayer {
	kind: SkillSourceLayerKind;
	dir: string;
}

export interface ResolvedSkill {
	name: string;
	skillDir: string;
	skillFilePath: string;
	sourceLayer: SkillSourceLayer;
}

export interface SkillResolutionOptions {
	workspacePath?: string;
	moduleDir?: string;
	bundledSkillsDir?: string | null;
}

export interface AsyncSkillDiscoveryFs {
	lstat: (path: string) => Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
	readdir: (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
}

export function resolveBundledSkillsDirSync(options?: { moduleDir?: string }): string | null {
	const here = options?.moduleDir ?? dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(here, ".agents/skills"),
		resolve(here, "../.agents/skills"),
		resolve(here, "../../.agents/skills"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

export function resolveSkillSourceLayersSync(options: SkillResolutionOptions = {}): SkillSourceLayer[] {
	const layers: SkillSourceLayer[] = [];
	if (options.workspacePath) {
		const projectSkillsDir = join(options.workspacePath, "fleet", "skills");
		if (existsSync(projectSkillsDir)) {
			layers.push({ kind: "project", dir: projectSkillsDir });
		}
	}

	const bundledSkillsDir =
		options.bundledSkillsDir === undefined
			? resolveBundledSkillsDirSync({ moduleDir: options.moduleDir })
			: options.bundledSkillsDir;
	if (bundledSkillsDir && existsSync(bundledSkillsDir)) {
		layers.push({ kind: "bundled", dir: bundledSkillsDir });
	}

	return layers;
}

export function resolveSkillSync(skillName: string, options: SkillResolutionOptions = {}): ResolvedSkill | null {
	for (const layer of resolveSkillSourceLayersSync(options)) {
		const skillDir = join(layer.dir, skillName);
		const skillFilePath = join(skillDir, "SKILL.md");
		if (existsSync(skillFilePath)) {
			return {
				name: skillName,
				skillDir,
				skillFilePath,
				sourceLayer: layer,
			};
		}
	}
	return null;
}

async function lstatExists(path: string, fs: Pick<AsyncSkillDiscoveryFs, "lstat">): Promise<boolean> {
	try {
		await fs.lstat(path);
		return true;
	} catch {
		return false;
	}
}

async function resolveSkillSourceLayers(
	options: SkillResolutionOptions,
	fs: AsyncSkillDiscoveryFs,
): Promise<SkillSourceLayer[]> {
	const layers: SkillSourceLayer[] = [];
	if (options.workspacePath) {
		const projectSkillsDir = join(options.workspacePath, "fleet", "skills");
		if (await lstatExists(projectSkillsDir, fs)) {
			layers.push({ kind: "project", dir: projectSkillsDir });
		}
	}

	const bundledSkillsDir =
		options.bundledSkillsDir === undefined
			? resolveBundledSkillsDirSync({ moduleDir: options.moduleDir })
			: options.bundledSkillsDir;
	if (bundledSkillsDir && (await lstatExists(bundledSkillsDir, fs))) {
		layers.push({ kind: "bundled", dir: bundledSkillsDir });
	}

	return layers;
}

export async function listResolvedSkills(
	options: SkillResolutionOptions = {},
	fs: AsyncSkillDiscoveryFs,
): Promise<ResolvedSkill[]> {
	const resolved: ResolvedSkill[] = [];
	const seen = new Set<string>();

	for (const layer of await resolveSkillSourceLayers(options, fs)) {
		for (const entry of await fs.readdir(layer.dir, { withFileTypes: true })) {
			if ((!entry.isDirectory() && !entry.isSymbolicLink()) || seen.has(entry.name)) {
				continue;
			}
			const skillDir = join(layer.dir, entry.name);
			const skillFilePath = join(skillDir, "SKILL.md");
			if (!(await lstatExists(skillFilePath, fs))) {
				continue;
			}
			seen.add(entry.name);
			resolved.push({
				name: entry.name,
				skillDir,
				skillFilePath,
				sourceLayer: layer,
			});
		}
	}

	return resolved;
}
