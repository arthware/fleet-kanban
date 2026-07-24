import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCardTypeManifest, resolveCanonicalCardTypesDir } from "../../../src/prompts/card-type-discovery";

describe("Card Type Discovery", () => {
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

	it("should find the canonical card-types dir", async () => {
		const tempModuleDir = await createTempDir("module-");
		const candidate1 = join(tempModuleDir, "fleet/card-types");

		await mkdir(candidate1, { recursive: true });

		const resolved = await resolveCanonicalCardTypesDir({
			moduleDir: tempModuleDir,
		});

		expect(resolved).toBe(candidate1);
	});

	it("should load card-types with project layer winning over built-in layer", async () => {
		const tempWorkspaceDir = await createTempDir("workspace-");
		const tempModuleDir = await createTempDir("module-");

		const builtinDir = join(tempModuleDir, "fleet/card-types");
		await mkdir(builtinDir, { recursive: true });
		await writeFile(
			join(builtinDir, "bug.md"),
			`---
name: bug
description: Built-in bug type
phases: []
---
`,
		);

		const projectDir = join(tempWorkspaceDir, "fleet/card-types");
		await mkdir(projectDir, { recursive: true });
		await writeFile(
			join(projectDir, "bug.md"),
			`---
name: bug
description: Project bug type
phases: []
---
`,
		);

		const manifest = await loadCardTypeManifest("bug", {
			workspacePath: tempWorkspaceDir,
			moduleDir: tempModuleDir,
		});

		expect(manifest).not.toBeNull();
		expect(manifest?.name).toBe("bug");
		expect(manifest?.description).toBe("Project bug type");
	});

	it("should resolve missing type in project layer to built-in layer", async () => {
		const tempWorkspaceDir = await createTempDir("workspace-");
		const tempModuleDir = await createTempDir("module-");

		const builtinDir = join(tempModuleDir, "fleet/card-types");
		await mkdir(builtinDir, { recursive: true });
		await writeFile(
			join(builtinDir, "spike.md"),
			`---
name: spike
description: Built-in spike type
phases: []
---
`,
		);

		const manifest = await loadCardTypeManifest("spike", {
			workspacePath: tempWorkspaceDir,
			moduleDir: tempModuleDir,
		});

		expect(manifest).not.toBeNull();
		expect(manifest?.name).toBe("spike");
		expect(manifest?.description).toBe("Built-in spike type");
	});

	it("should return null when manifest is not found in either layer", async () => {
		const tempWorkspaceDir = await createTempDir("workspace-");
		const tempModuleDir = await createTempDir("module-");

		const manifest = await loadCardTypeManifest("unknown", {
			workspacePath: tempWorkspaceDir,
			moduleDir: tempModuleDir,
		});

		expect(manifest).toBeNull();
	});
});
