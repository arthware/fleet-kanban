import type { Command } from "commander";
import { resolveStartActiveSkills, validateCardType } from "../core/card-type";
import { loadCardTypeManifest } from "../prompts/card-type-discovery";
import { composeCardDirective, resolveCanonicalSkillsDirSync } from "../prompts/compose-card-directive";

export interface CardTypeValidateOptions {
	projectPath?: string;
	moduleDir?: string;
	skillsDir?: string;
	stdout?: (msg: string) => void;
	stderr?: (msg: string) => void;
}

export async function executeCardTypeValidate(name: string, options: CardTypeValidateOptions = {}): Promise<boolean> {
	const projectPath = options.projectPath ?? process.cwd();
	const stdout = options.stdout ?? ((msg: string) => process.stdout.write(`${msg}\n`));
	const stderr = options.stderr ?? ((msg: string) => process.stderr.write(`${msg}\n`));

	// Load card-type manifest
	const manifest = await loadCardTypeManifest(name, {
		workspacePath: projectPath,
		moduleDir: options.moduleDir,
	});

	if (!manifest) {
		const errMsg = `Error: Card type manifest "${name}" not found in project or built-in layers.`;
		stderr(errMsg);
		throw new Error(errMsg);
	}

	// Resolve skills directory
	const skillsDir = options.skillsDir ?? resolveCanonicalSkillsDirSync({ moduleDir: options.moduleDir });

	if (!skillsDir) {
		const errMsg = "Error: Skills directory could not be resolved.";
		stderr(errMsg);
		throw new Error(errMsg);
	}

	// Perform validation
	const result = validateCardType(manifest, skillsDir);

	// Formatting outputs
	stdout(`Card Type: ${manifest.name} (${manifest.description || "No description"})`);
	stdout("");
	stdout("Phases:");
	for (const phase of result.phases) {
		stdout(`- ${phase.name} → ${phase.lane} → ${phase.activation}`);
		stdout("  Skills:");
		for (const skill of phase.skills) {
			const statusLabel = skill.status === "ok" ? "ok" : skill.status;
			stdout(`    - ${skill.name} [${statusLabel}]`);
		}
	}
	stdout("");

	// Composed directives
	// State 1: Default active skills
	const defaultSkills = resolveStartActiveSkills(manifest, {
		autoReviewEnabled: false,
	});
	const defaultDirective = composeCardDirective(defaultSkills, {
		baseRef: "main",
		canonicalSkillsDir: skillsDir,
		moduleDir: options.moduleDir,
	});

	stdout("Composed Directive (default):");
	stdout("========================================");
	stdout(defaultDirective.trim());
	stdout("========================================");
	stdout("");

	// State 2: With --auto-review pr
	const prSkills = resolveStartActiveSkills(manifest, {
		autoReviewEnabled: true,
		autoReviewMode: "pr",
	});
	const prDirective = composeCardDirective(prSkills, {
		baseRef: "main",
		canonicalSkillsDir: skillsDir,
		moduleDir: options.moduleDir,
	});

	stdout("Composed Directive (with --auto-review pr):");
	stdout("========================================");
	stdout(prDirective.trim());
	stdout("========================================");

	// Loud failure
	if (!result.isValid) {
		// Find first offending skill
		for (const phase of result.phases) {
			for (const skill of phase.skills) {
				if (skill.status !== "ok") {
					const errMsg = `Validation failed: ${skill.name} is missing or has an empty directive`;
					stderr(`Error: ${errMsg}`);
					throw new Error(errMsg);
				}
			}
		}
	}

	return true;
}

export function registerCardTypeCommand(program: Command): void {
	const cardType = program.command("card-type").description("Manage Kanban card-types");

	cardType
		.command("validate <name>")
		.description("Validate a card-type workflow manifest and its referenced skills")
		.option("--project-path <path>", "Workspace path. Defaults to current directory workspace.")
		.action(async (name: string, options: { projectPath?: string }) => {
			try {
				await executeCardTypeValidate(name, {
					projectPath: options.projectPath,
				});
			} catch (_error) {
				// Errors are already logged to stderr within executeCardTypeValidate
				process.exitCode = 1;
			}
		});
}
