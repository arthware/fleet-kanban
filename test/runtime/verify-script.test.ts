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

	// Rule-based vitest checker: Find all vitest run invocations
	const vitestRunRegex = /vitest\s+run\b([^&|;\n()]*)/g;
	let match = vitestRunRegex.exec(expandedScript);
	while (match !== null) {
		const argsStr = match[1];
		const argTokens = argsStr
			.trim()
			.split(/\s+/)
			.filter((t) => t.length > 0);

		// Extract positional arguments (which must be path-like arguments, not option flags or option values)
		const positionalArgs: string[] = [];
		for (let i = 0; i < argTokens.length; i++) {
			const token = argTokens[i];
			if (token.startsWith("-")) {
				// skip any option value if option takes one
				if (token === "--config" || token === "-c" || token === "--exclude" || token === "--reporter") {
					i++;
				}
			} else {
				positionalArgs.push(token);
			}
		}

		if (positionalArgs.length === 0) {
			throw new Error("vitest run must name explicit path arguments rather than sweeping the repo");
		}

		// Verify that it excludes live tests
		let hasExcludeLive = false;
		for (let i = 0; i < argTokens.length; i++) {
			if (argTokens[i] === "--exclude" && i + 1 < argTokens.length) {
				const excludeVal = argTokens[i + 1];
				if (excludeVal.includes(".live.test.ts")) {
					hasExcludeLive = true;
				}
			}
		}

		if (!hasExcludeLive) {
			throw new Error("vitest run must exclude live tests (**/*.live.test.ts)");
		}

		match = vitestRunRegex.exec(expandedScript);
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
	it("givenScriptReferencingTestIntegrationWhenCheckedThenItThrows", () => {
		const mockScripts = {
			verify: "npm run verify:precommit",
			"verify:precommit": "npm run test:integration",
		};
		const expanded = expandScript("verify", mockScripts);
		expect(() => assertScriptIsSafe(expanded)).toThrow("verify script must not reference test:integration");
	});

	it("givenScriptReferencingUnscopedVitestRunWhenCheckedThenItThrows", () => {
		const mockScripts = {
			verify: "npm run verify:precommit",
			"verify:precommit": "vitest run",
		};
		const expanded = expandScript("verify", mockScripts);
		expect(() => assertScriptIsSafe(expanded)).toThrow(
			"vitest run must name explicit path arguments rather than sweeping the repo",
		);
	});

	it("givenScriptMissingExcludeLiveWhenCheckedThenItThrows", () => {
		const mockScripts = {
			verify: "npm run verify:precommit",
			"verify:precommit": "vitest run test/runtime",
		};
		const expanded = expandScript("verify", mockScripts);
		expect(() => assertScriptIsSafe(expanded)).toThrow("vitest run must exclude live tests (**/*.live.test.ts)");
	});

	it("givenScriptReferencingUnscopedRootTestWhenCheckedThenItThrows", () => {
		const mockScripts = {
			verify: "npm run verify:precommit",
			"verify:precommit": "npm run test",
		};
		const expanded = expandScript("verify", mockScripts);
		expect(() => assertScriptIsSafe(expanded)).toThrow(
			"verify script must not reference unscoped root test or check scripts",
		);
	});

	it("givenValidScopedScriptChainWhenCheckedThenItDoesNotThrow", () => {
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
