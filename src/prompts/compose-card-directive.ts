import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

/**
 * Resolves the canonical skills directory synchronously.
 */
export function resolveCanonicalSkillsDirSync(options?: { moduleDir?: string }): string | null {
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

/**
 * Composes card directives from the given ordered list of skills.
 */
export function composeCardDirective(
	orderedSkillNames: string[],
	ctx: {
		baseRef: string;
		canonicalSkillsDir?: string | null;
		moduleDir?: string;
	},
): string {
	const canonicalSkillsDir = ctx.canonicalSkillsDir ?? resolveCanonicalSkillsDirSync({ moduleDir: ctx.moduleDir });

	if (!canonicalSkillsDir) {
		return "";
	}

	let composed = "";

	for (const skillName of orderedSkillNames) {
		const skillPath = join(canonicalSkillsDir, skillName, "SKILL.md");
		if (existsSync(skillPath)) {
			const fileContent = readFileSync(skillPath, "utf-8");
			const { data } = matter(fileContent);
			if (data && typeof data.directive === "string" && data.directive.trim() !== "") {
				let directiveText = data.directive;
				directiveText = directiveText.replace(/\${baseRef}/g, ctx.baseRef);
				composed += `${directiveText}\n\n`;
			}
		}
	}

	return composed;
}
