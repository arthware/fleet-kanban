import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeCardTypeValidate } from "../../../src/commands/card-type";

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
		const combinedOut = stdoutMsgs.join("\n") + "\n" + stderrMsgs.join("\n");
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

		const combinedOut = stdoutMsgs.join("\n") + "\n" + stderrMsgs.join("\n");
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
});
