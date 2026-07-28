import { existsSync, readdirSync } from "node:fs";
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
	canonicalSkillsDir?: string | null;
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

	const hasCanonicalSkillsDir = options.canonicalSkillsDir !== undefined;
	const bundledSkillsDir =
		options.bundledSkillsDir !== undefined
			? options.bundledSkillsDir
			: hasCanonicalSkillsDir
				? options.canonicalSkillsDir
				: resolveBundledSkillsDirSync({ moduleDir: options.moduleDir });
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

export function listResolvedSkillsSync(options: SkillResolutionOptions = {}): ResolvedSkill[] {
	const resolved: ResolvedSkill[] = [];
	const seen = new Set<string>();

	for (const layer of resolveSkillSourceLayersSync(options)) {
		for (const entry of readdirSync(layer.dir, { withFileTypes: true })) {
			if ((!entry.isDirectory() && !entry.isSymbolicLink()) || seen.has(entry.name)) {
				continue;
			}
			const skillDir = join(layer.dir, entry.name);
			const skillFilePath = join(skillDir, "SKILL.md");
			if (!existsSync(skillFilePath)) {
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
