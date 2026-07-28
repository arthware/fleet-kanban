import { existsSync, readFileSync } from "node:fs";
import matter from "gray-matter";
import { resolveBundledSkillsDirSync, resolveSkillSync } from "./skill-discovery";

/**
 * Resolves the canonical skills directory synchronously.
 */
export function resolveCanonicalSkillsDirSync(options?: { moduleDir?: string }): string | null {
	return resolveBundledSkillsDirSync(options);
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
		workspacePath?: string;
	},
): string {
	let composed = "";

	for (const skillName of orderedSkillNames) {
		const resolvedSkill = resolveSkillSync(skillName, {
			workspacePath: ctx.workspacePath,
			moduleDir: ctx.moduleDir,
			canonicalSkillsDir: ctx.canonicalSkillsDir,
		});
		if (resolvedSkill && existsSync(resolvedSkill.skillFilePath)) {
			const fileContent = readFileSync(resolvedSkill.skillFilePath, "utf-8");
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
