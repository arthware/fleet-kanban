import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
	name?: string;
	run?: string;
	uses?: string;
}

interface WorkflowJob {
	steps?: WorkflowStep[];
}

interface Workflow {
	jobs?: {
		"build-check-test"?: WorkflowJob;
	};
}

function expandScript(scriptName: string, scripts: Record<string, string>, visited = new Set<string>()): string {
	if (visited.has(scriptName)) {
		throw new Error(`Circular dependency detected in scripts: ${[...visited, scriptName].join(" -> ")}`);
	}
	visited.add(scriptName);
	const scriptCmd = scripts[scriptName];
	if (!scriptCmd) {
		return "";
	}
	// Transitively resolve 'npm run X' or 'npm run-script X'
	return scriptCmd.replace(/npm\s+run(?:-script)?\s+([a-zA-Z0-9_\-:]+)/g, (match, subScript) => {
		const expanded = expandScript(subScript, scripts, new Set(visited));
		return expanded ? `(${expanded})` : match;
	});
}

function assertScriptIsSafe(expandedScript: string) {
	if (expandedScript.includes("test:integration")) {
		throw new Error("verify script must not reference test:integration");
	}

	// Allowed vitest run command is exactly test:fast:
	// "vitest run test/runtime test/utilities test/agents --exclude "**/*.live.test.ts""
	const sanitized = expandedScript.replace(
		/vitest\s+run\s+test\/runtime\s+test\/utilities\s+test\/agents\s+--exclude\s+"[^"']+"/g,
		"",
	);
	if (sanitized.includes("vitest run")) {
		throw new Error("verify script must not reference unscoped vitest run");
	}

	// Also check for unscoped root npm run test or npm test
	const hasUnscopedRootTest =
		(expandedScript.includes("npm run test") && !expandedScript.includes("npm run test:fast")) ||
		expandedScript.includes("npm test") ||
		expandedScript.includes("npm run check");
	if (hasUnscopedRootTest) {
		throw new Error("verify script must not reference unscoped root test or check scripts");
	}
}

describe("CI Workflow vs Verify Script Alignment", () => {
	it("givenCiWorkflowWhenComparedToVerifyScriptThenTheyRunTheSameChecks", () => {
		// 1. Read and parse .github/workflows/test.yml
		const workflowPath = path.resolve(__dirname, "../../.github/workflows/test.yml");
		const workflowContent = fs.readFileSync(workflowPath, "utf8");
		const parsedWorkflow = load(workflowContent) as Workflow;

		const steps = parsedWorkflow?.jobs?.["build-check-test"]?.steps;
		expect(steps).toBeDefined();

		// Check steps with 'run' property
		for (const step of steps || []) {
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

		const expandedVerifyScript = expandScript("verify", packageJson.scripts);

		// Assert transitively expanded verify script is safe
		assertScriptIsSafe(expandedVerifyScript);
	});
});

describe("verify transitive rules assertions", () => {
	it("should throw when expanding a script that references test:integration", () => {
		const mockScripts = {
			verify: "npm run verify:precommit",
			"verify:precommit": "npm run test:integration",
		};
		const expanded = expandScript("verify", mockScripts);
		expect(() => assertScriptIsSafe(expanded)).toThrow("verify script must not reference test:integration");
	});

	it("should throw when expanding a script that references unscoped vitest run", () => {
		const mockScripts = {
			verify: "npm run verify:precommit",
			"verify:precommit": "vitest run",
		};
		const expanded = expandScript("verify", mockScripts);
		expect(() => assertScriptIsSafe(expanded)).toThrow("verify script must not reference unscoped vitest run");
	});

	it("should throw when expanding a script that references unscoped root npm run test", () => {
		const mockScripts = {
			verify: "npm run verify:precommit",
			"verify:precommit": "npm run test",
		};
		const expanded = expandScript("verify", mockScripts);
		expect(() => assertScriptIsSafe(expanded)).toThrow(
			"verify script must not reference unscoped root test or check scripts",
		);
	});

	it("should not throw when expanding a valid scoped script chain", () => {
		const mockScripts = {
			verify: "npm run verify:precommit && npm run web:build",
			"verify:precommit": "npm run lint && npm run typecheck && npm run test:fast && npm --prefix web-ui run test",
			lint: "biome lint .",
			typecheck: "tsc",
			"test:fast": 'vitest run test/runtime test/utilities test/agents --exclude "**/*.live.test.ts"',
			"web:build": "npm --prefix web-ui run build",
		};
		const expanded = expandScript("verify", mockScripts);
		expect(() => assertScriptIsSafe(expanded)).not.toThrow();
	});
});
