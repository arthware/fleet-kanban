import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentDriver, AgentObservationMessage, AgentUsage } from "../../../src/agents/driver";

export interface LiveTckExpectations {
	assertMessages?: (messages: readonly AgentObservationMessage[]) => void;
	assertUsage?: (usage: AgentUsage) => void;
}

export interface LiveTckOptions {
	args: (sessionId: string) => string[];
	env?: Record<string, string>;
	requiredEnv?: readonly string[];
	discoverSessionId?: (home: string) => { sessionId: string } | null | Promise<{ sessionId: string } | null>;
	expectations?: LiveTckExpectations;
}

interface TestSummary {
	executed: boolean;
	skipped: boolean;
	reason: string;
}

const summary: Record<string, TestSummary> = {};

/**
 * Build the launch environment the way the runtime does, by asking the driver for it.
 *
 * A CLI needs more than a binary and arguments to run in a directory nobody has
 * interactively approved — Gemini, for one, refuses to start in a folder it does not
 * trust, and the driver answers that by writing a settings file and pointing the CLI at
 * it. A test that hand-rolls the spawn skips all of that, so it fails for reasons the
 * product does not have, and proves nothing about the driver it is named after.
 *
 * The plan's files land under a throwaway CLINE_HOME so a test run never writes into the
 * operator's real runtime home. Card-session concerns (hooks, prompts, resume) stay out:
 * `workspaceId: null` asks the driver for the plain launch environment, which is all a
 * one-shot conformance turn needs.
 */
async function prepareDriverEnvironment(driver: AgentDriver): Promise<Record<string, string | undefined>> {
	const throwawayRuntimeHome = mkdtempSync(join(tmpdir(), `tck-${driver.id}-home-`));
	const previousClineHome = process.env.CLINE_HOME;
	process.env.CLINE_HOME = throwawayRuntimeHome;
	try {
		const plan = await driver.launch.prepare({
			taskId: `tck-${driver.id}`,
			prompt: "",
			cwd: process.cwd(),
			env: {},
			args: [],
			autonomousModeEnabled: false,
			agentSessionId: null,
			resumeSession: false,
			resumeFromTrash: false,
			agentModel: null,
			workspaceId: null,
			architectContextPreamble: null,
		});
		if (!plan.supported) {
			return {};
		}
		for (const file of plan.value.filesToWrite ?? []) {
			mkdirSync(dirname(file.path), { recursive: true });
			writeFileSync(file.path, file.content, "utf8");
		}
		return plan.value.env;
	} finally {
		if (previousClineHome === undefined) {
			delete process.env.CLINE_HOME;
		} else {
			process.env.CLINE_HOME = previousClineHome;
		}
	}
}

function getRealHome(): string {
	if (process.platform === "win32") {
		return process.env.USERPROFILE || `C:\\Users\\${process.env.USERNAME || "Default"}`;
	}
	if (process.platform === "darwin") {
		const user = process.env.USER || process.env.LOGNAME || "arthur";
		return `/Users/${user}`;
	}
	const user = process.env.USER || process.env.LOGNAME || "root";
	return `/home/${user}`;
}

function getCleanSystemEnv(): Record<string, string | undefined> {
	const env = { ...process.env };
	if (env.PATH) {
		env.PATH = env.PATH.split(":")
			.filter((p) => !p.includes("node_modules"))
			.join(":");
	}
	const realHome = getRealHome();
	const asdfPath = join(realHome, ".asdf");
	if (existsSync(asdfPath)) {
		env.ASDF_DATA_DIR = asdfPath;
	}
	return env;
}

export function resolveBinaryExecutable(binary: string): string | null {
	const cleanEnv = getCleanSystemEnv();

	// Ensure .tool-versions is present in process.env.HOME so asdf shims work during resolution
	if (process.env.HOME) {
		const realToolVersions = join(getRealHome(), ".tool-versions");
		const isolatedToolVersions = join(process.env.HOME, ".tool-versions");
		if (existsSync(realToolVersions) && !existsSync(isolatedToolVersions)) {
			try {
				copyFileSync(realToolVersions, isolatedToolVersions);
			} catch {}
		}
	}

	// 1. Try finding it directly on clean PATH
	try {
		const whichRes = spawnSync("which", [binary], { env: cleanEnv });
		if (whichRes.status === 0) {
			const resolvedPath = whichRes.stdout?.toString().trim();
			if (resolvedPath) {
				// Verify if it works (some asdf shims are broken/empty in non-global contexts)
				const checkRes = spawnSync(resolvedPath, ["--version"], { env: cleanEnv });
				if (checkRes.status === 0) {
					return resolvedPath;
				}
			}
		}
	} catch {}

	// 2. Best-guess search standard paths and dynamically scan asdf node versions
	const home = homedir();
	const searchPaths = [
		"/opt/homebrew/bin",
		"/usr/local/bin",
		join(home, ".local", "bin"),
		join(home, ".npm-global", "bin"),
	];

	try {
		const asdfNodejsRoot = join(home, ".asdf", "installs", "nodejs");
		const versions = readdirSync(asdfNodejsRoot);
		for (const ver of versions) {
			searchPaths.push(join(asdfNodejsRoot, ver, "bin"));
		}
	} catch {}

	for (const dir of searchPaths) {
		const candidate = join(dir, binary);
		try {
			if (statSync(candidate).isFile()) {
				const checkRes = spawnSync(candidate, ["--version"], { env: cleanEnv });
				if (checkRes.status === 0) {
					return candidate;
				}
			}
		} catch {}
	}

	return null;
}

function isUnauthenticated(runResult: { error?: any; status: number | null; stdout?: any; stderr?: any }): boolean {
	if (runResult.error) {
		return false;
	}
	const out = (runResult.stdout?.toString() || "") + (runResult.stderr?.toString() || "");
	const outLower = out.toLowerCase();
	return (
		outLower.includes("login") ||
		outLower.includes("unauthenticated") ||
		outLower.includes("authenticate") ||
		outLower.includes("auth") ||
		outLower.includes("sign-in") ||
		outLower.includes("credentials") ||
		outLower.includes("api key") ||
		outLower.includes("api-key") ||
		outLower.includes("api_key") ||
		outLower.includes("not logged in") ||
		outLower.includes("unauthorized")
	);
}

export function registerLiveSummaryHandler(): void {
	afterAll(() => {
		console.log("\n======================================================================");
		console.log("TCK LIVE CONFORMANCE RUN SUMMARY");
		console.log("======================================================================");
		for (const [driverName, result] of Object.entries(summary)) {
			const status = result.executed ? "EXECUTED (1 live turn completed)" : `SKIPPED (${result.reason})`;
			console.log(`${driverName.toUpperCase()} driver: ${status}`);
		}
		console.log("======================================================================\n");

		const allSkipped = Object.values(summary).every((r) => r.skipped);
		if (allSkipped && process.env.TCK_LIVE_ALLOW_EMPTY !== "1") {
			console.error("ERROR: Every live driver test was skipped, and TCK_LIVE_ALLOW_EMPTY is not set.");
			process.exit(1);
		}
	});
}

export function describeLiveDriverTck(driver: AgentDriver, options: LiveTckOptions): void {
	summary[driver.id] = { executed: false, skipped: false, reason: "pending" };

	describe(`${driver.id} Live Conformance`, () => {
		it("runs a live turn and parses observation results", async (ctx) => {
			try {
				const binaryName = driver.catalog.binary;
				const executablePath = resolveBinaryExecutable(binaryName);
				if (!executablePath) {
					summary[driver.id] = { executed: false, skipped: true, reason: `${binaryName} binary not found` };
					ctx.skip();
					return;
				}

				if (options.requiredEnv) {
					for (const key of options.requiredEnv) {
						if (!process.env[key]) {
							summary[driver.id] = { executed: false, skipped: true, reason: `${key} env var missing` };
							ctx.skip();
							return;
						}
					}
				}

				const sessionId = randomUUID();
				const home = getRealHome();
				const driverEnvironment = await prepareDriverEnvironment(driver);

				const runEnv = {
					...getCleanSystemEnv(),
					HOME: home,
					USERPROFILE: home,
					...driverEnvironment,
					...options.env,
				};

				const runResult = spawnSync(executablePath, options.args(sessionId), {
					env: runEnv,
					timeout: 30000,
				});

				if (runResult.error || runResult.status !== 0) {
					if (isUnauthenticated(runResult)) {
						const code = runResult.status !== null ? `Exit code ${runResult.status}` : "Error";
						const out = (runResult.stdout?.toString() || "") + (runResult.stderr?.toString() || "");
						const cleanOut = out.replace(/\s+/g, " ").trim().substring(0, 300);
						const detailedReason = `Not authenticated (${code}: "${cleanOut}")`;

						summary[driver.id] = { executed: false, skipped: true, reason: detailedReason };
						ctx.skip();
						return;
					} else {
						const errMsg =
							runResult.error?.message || runResult.stderr?.toString() || `Exit code ${runResult.status}`;
						throw new Error(`${driver.id.toUpperCase()} CLI execution failed: ${errMsg}`);
					}
				}

				const targetSessionId = options.discoverSessionId
					? (await options.discoverSessionId(home))?.sessionId
					: sessionId;
				if (!targetSessionId) {
					throw new Error(`Failed to discover session ID for ${driver.id}`);
				}

				const presentResult = await driver.observe.artifactPresent({ sessionId: targetSessionId, homePath: home });
				expect(presentResult.supported).toBe(true);
				if (presentResult.supported) {
					expect(presentResult.value).toBe(true);
				}

				const messagesResult = await driver.observe.messages({ sessionId: targetSessionId, homePath: home });
				expect(messagesResult.supported).toBe(true);
				if (messagesResult.supported) {
					expect(messagesResult.value.length).toBeGreaterThan(0);
					if (options.expectations?.assertMessages) {
						options.expectations.assertMessages(messagesResult.value);
					}
				}

				const usageResult = await driver.observe.usage({ sessionId: targetSessionId, homePath: home });
				expect(usageResult.supported).toBe(true);
				if (usageResult.supported) {
					if (options.expectations?.assertUsage) {
						options.expectations.assertUsage(usageResult.value);
					}
				}

				summary[driver.id] = { executed: true, skipped: false, reason: "" };
			} catch (error: any) {
				if (summary[driver.id].skipped) {
					throw error;
				}
				summary[driver.id] = { executed: false, skipped: false, reason: `failed: ${error.message}` };
				throw error;
			}
		});
	});
}
