import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

describe("CI Workflow vs Verify Script Alignment", () => {
	it("givenCiWorkflowWhenComparedToVerifyScriptThenTheyRunTheSameChecks", () => {
		// 1. Read and parse .github/workflows/test.yml
		const workflowPath = path.resolve(__dirname, "../../.github/workflows/test.yml");
		const workflowContent = fs.readFileSync(workflowPath, "utf8");
		const parsedWorkflow = yaml.load(workflowContent) as any;

		const steps = parsedWorkflow?.jobs?.["build-check-test"]?.steps;
		expect(steps).toBeDefined();

		// Check steps with 'run' property
		for (const step of steps) {
			if (step.run) {
				const runCmd = step.run.trim();
				const isInstallOrSetup =
					runCmd.includes("npm ci") ||
					runCmd.includes("git config") ||
					runCmd.includes("npm i") ||
					runCmd.includes("npm install");

				if (!isInstallOrSetup) {
					expect(runCmd).toContain("npm run verify");
				}
			}
		}

		// 2. Read and parse package.json
		const packageJsonPath = path.resolve(__dirname, "../../package.json");
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

		expect(packageJson.scripts).toBeDefined();
		expect(packageJson.scripts.verify).toBeDefined();

		const verifyScript = packageJson.scripts.verify;

		// Assert verify does not reference test:integration
		expect(verifyScript).not.toContain("test:integration");

		// Assert verify does not reference vitest run without the test:fast scoping
		expect(verifyScript).not.toContain("vitest run");

		// Assert that root test or check scripts are not run without test:fast scoping
		const hasUnscopedRootTest =
			(verifyScript.includes("npm run test") && !verifyScript.includes("npm run test:fast")) ||
			verifyScript.includes("npm test") ||
			verifyScript.includes("npm run check");
		expect(hasUnscopedRootTest).toBe(false);
	});
});
