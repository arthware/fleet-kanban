import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeCardTypeValidate } from "../../../src/commands/card-type";
import { validateCardType } from "../../../src/core/card-type";

describe("Card Type Validate Command", () => {
	let tempDirs: string[] = [];

	async function createTempDir(prefix: string): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(async () => {
		for (const dir of tempDirs) {
			try {
				await rm(dir, { recursive: true, force: true });
			} catch {}
		}
		tempDirs = [];
	});

	it("given a fixture manifest referencing a missing skill, when validate is called, then it reports it and fails", async () => {
		// Arrange
		const tempWorkspaceDir = await createTempDir("workspace-");
		const tempModuleDir = await createTempDir("module-");

		// Create workspace card-type manifest
		const projectDir = join(tempWorkspaceDir, "fleet/card-types");
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(projectDir, "custom-build.md"),
			`---
name: custom-build
description: Custom build workflow manifest
phases:
  - name: build
    lane: in_progress
    skills:
      - missing-skill-1
    activation: default
---
`,
		);

		// Create skills directory
		const skillsDir = join(tempModuleDir, ".agents/skills");
		await mkdir(skillsDir, { recursive: true });

		const stdoutMsgs: string[] = [];
		const stderrMsgs: string[] = [];
		const stdout = (m: string) => stdoutMsgs.push(m);
		const stderr = (m: string) => stderrMsgs.push(m);

		// Act & Assert
		await expect(
			executeCardTypeValidate("custom-build", {
				projectPath: tempWorkspaceDir,
				moduleDir: tempModuleDir,
				skillsDir,
				stdout,
				stderr,
			}),
		).rejects.toThrow("Validation failed: missing-skill-1 is missing or has an empty directive");

		// Then we expect missing-skill-1 to be marked as MISSING
		const combinedOut = `${stdoutMsgs.join("\n")}\n${stderrMsgs.join("\n")}`;
		expect(combinedOut).toContain("missing-skill-1");
		expect(combinedOut).toContain("MISSING");
	});

	it("given a fixture manifest referencing a skill with an empty directive:, when validate is called, then it flags EMPTY-DIRECTIVE and fails", async () => {
		// Arrange
		const tempWorkspaceDir = await createTempDir("workspace-");
		const tempModuleDir = await createTempDir("module-");

		// Create workspace card-type manifest
		const projectDir = join(tempWorkspaceDir, "fleet/card-types");
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(projectDir, "empty-build.md"),
			`---
name: empty-build
description: Empty build workflow manifest
phases:
  - name: build
    lane: in_progress
    skills:
      - empty-directive-skill
    activation: default
---
`,
		);

		// Create skills directory
		const skillsDir = join(tempModuleDir, ".agents/skills");
		await mkdir(skillsDir, { recursive: true });

		// Create empty directive skill
		const emptySkillDir = join(skillsDir, "empty-directive-skill");
		await mkdir(emptySkillDir, { recursive: true });
		await writeFile(
			join(emptySkillDir, "SKILL.md"),
			`---
directive: ""
---
Some content
`,
		);

		const stdoutMsgs: string[] = [];
		const stderrMsgs: string[] = [];
		const stdout = (m: string) => stdoutMsgs.push(m);
		const stderr = (m: string) => stderrMsgs.push(m);

		// Act & Assert
		await expect(
			executeCardTypeValidate("empty-build", {
				projectPath: tempWorkspaceDir,
				moduleDir: tempModuleDir,
				skillsDir,
				stdout,
				stderr,
			}),
		).rejects.toThrow("Validation failed: empty-directive-skill is missing or has an empty directive");

		const combinedOut = `${stdoutMsgs.join("\n")}\n${stderrMsgs.join("\n")}`;
		expect(combinedOut).toContain("empty-directive-skill");
		expect(combinedOut).toContain("EMPTY-DIRECTIVE");
	});

	it("given a valid type, when validate is called, then it exits zero and prints previews for both default and --auto-review pr", async () => {
		// Arrange
		const tempWorkspaceDir = await createTempDir("workspace-");
		const tempModuleDir = await createTempDir("module-");

		// Create workspace card-type manifest
		const projectDir = join(tempWorkspaceDir, "fleet/card-types");
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(projectDir, "valid-build.md"),
			`---
name: valid-build
description: A clean build workflow manifest
phases:
  - name: build
    lane: in_progress
    skills:
      - good-skill-1
    activation: default
  - name: ship
    lane: in_progress
    skills:
      - good-skill-2
    activation: auto-review-pr
---
`,
		);

		// Create skills directory
		const skillsDir = join(tempModuleDir, ".agents/skills");
		await mkdir(skillsDir, { recursive: true });

		// Create good skills
		const goodSkillDir1 = join(skillsDir, "good-skill-1");
		await mkdir(goodSkillDir1, { recursive: true });
		await writeFile(
			join(goodSkillDir1, "SKILL.md"),
			`---
directive: "Direct instructions for skill 1."
---
`,
		);

		const goodSkillDir2 = join(skillsDir, "good-skill-2");
		await mkdir(goodSkillDir2, { recursive: true });
		await writeFile(
			join(goodSkillDir2, "SKILL.md"),
			`---
directive: "Direct instructions for skill 2 with \${baseRef}."
---
`,
		);

		const stdoutMsgs: string[] = [];
		const stderrMsgs: string[] = [];
		const stdout = (m: string) => stdoutMsgs.push(m);
		const stderr = (m: string) => stderrMsgs.push(m);

		// Act
		const success = await executeCardTypeValidate("valid-build", {
			projectPath: tempWorkspaceDir,
			moduleDir: tempModuleDir,
			skillsDir,
			stdout,
			stderr,
		});

		// Assert
		expect(success).toBe(true);
		expect(stderrMsgs).toHaveLength(0);

		const combinedOut = stdoutMsgs.join("\n");
		expect(combinedOut).toContain("good-skill-1");
		expect(combinedOut).toContain("good-skill-2");
		expect(combinedOut).toContain("ok");

		expect(combinedOut).toContain("Composed Directive (default):");
		expect(combinedOut).toContain("Direct instructions for skill 1.");

		const defaultSection = combinedOut.slice(
			combinedOut.indexOf("Composed Directive (default):"),
			combinedOut.indexOf("Composed Directive (with --auto-review pr):"),
		);
		expect(defaultSection).not.toContain("Direct instructions for skill 2");

		expect(combinedOut).toContain("Composed Directive (with --auto-review pr):");
		expect(combinedOut).toContain("Direct instructions for skill 1.");
		expect(combinedOut).toContain("Direct instructions for skill 2 with main.");
	});

	it("given a project card type referencing a project skill, when validate is called, then it reports the skill as ok", async () => {
		// Arrange
		const tempWorkspaceDir = await createTempDir("workspace-");
		const tempModuleDir = await createTempDir("module-");
		const projectCardTypesDir = join(tempWorkspaceDir, "fleet/card-types");
		const projectSkillsDir = join(tempWorkspaceDir, "fleet/skills/my-skill");
		await mkdir(projectCardTypesDir, { recursive: true });
		await mkdir(projectSkillsDir, { recursive: true });
		await writeFile(
			join(projectCardTypesDir, "custom-build.md"),
			`---
name: custom-build
description: Custom build workflow manifest
phases:
  - name: build
    lane: in_progress
    skills:
      - my-skill
    activation: default
---
`,
		);
		await writeFile(
			join(projectSkillsDir, "SKILL.md"),
			`---
name: my-skill
directive: "Project skill directive."
---
`,
		);
		await mkdir(join(tempModuleDir, ".agents/skills"), { recursive: true });

		const stdoutMsgs: string[] = [];
		const stderrMsgs: string[] = [];

		// Act
		const success = await executeCardTypeValidate("custom-build", {
			projectPath: tempWorkspaceDir,
			moduleDir: tempModuleDir,
			stdout: (m: string) => stdoutMsgs.push(m),
			stderr: (m: string) => stderrMsgs.push(m),
		});

		// Assert
		expect(success).toBe(true);
		expect(stderrMsgs).toHaveLength(0);
		expect(stdoutMsgs.join("\n")).toContain("my-skill [ok]");
		expect(stdoutMsgs.join("\n")).toContain("Project skill directive.");
	});
});

describe("validateCardType & validateSkill module core", () => {
	let tempDirs: string[] = [];

	async function createTempDir(prefix: string): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	afterEach(async () => {
		for (const dir of tempDirs) {
			try {
				await rm(dir, { recursive: true, force: true });
			} catch {}
		}
		tempDirs = [];
	});

	it("given a manifest referencing a missing skill, when validateCardType is evaluated, then it returns isValid=false and status MISSING", async () => {
		// Arrange
		const skillsDir = await createTempDir("skills-missing-");
		const manifest = {
			name: "test-missing",
			description: "manifest with missing skill",
			phases: [
				{
					name: "build",
					lane: "in_progress" as const,
					skills: ["missing-skill"],
					activation: "default" as const,
				},
			],
		};

		// Act
		const result = validateCardType(manifest, skillsDir);

		// Assert
		expect(result.isValid).toBe(false);
		expect(result.phases).toHaveLength(1);
		expect(result.phases[0].skills).toHaveLength(1);
		expect(result.phases[0].skills[0]).toEqual({
			name: "missing-skill",
			status: "MISSING",
		});
	});

	it("given a manifest referencing an empty directive skill, when validateCardType is evaluated, then it returns isValid=false and status EMPTY-DIRECTIVE", async () => {
		// Arrange
		const skillsDir = await createTempDir("skills-empty-");
		const skillName = "empty-skill";
		const skillPath = join(skillsDir, skillName);
		await mkdir(skillPath, { recursive: true });
		await writeFile(
			join(skillPath, "SKILL.md"),
			`---
directive: ""
---
`,
		);

		const manifest = {
			name: "test-empty",
			description: "manifest with empty directive skill",
			phases: [
				{
					name: "build",
					lane: "in_progress" as const,
					skills: [skillName],
					activation: "default" as const,
				},
			],
		};

		// Act
		const result = validateCardType(manifest, skillsDir);

		// Assert
		expect(result.isValid).toBe(false);
		expect(result.phases).toHaveLength(1);
		expect(result.phases[0].skills).toHaveLength(1);
		expect(result.phases[0].skills[0]).toEqual({
			name: skillName,
			status: "EMPTY-DIRECTIVE",
		});
	});
});
