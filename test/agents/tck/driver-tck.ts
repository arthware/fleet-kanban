import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AgentDriver, DriverSessionRef } from "../../../src/agents/driver";
import type { AgentFact, SessionSignal } from "../../../src/agents/session-signal";
import {
	getClaudeMockTranscriptPath,
	getCodexMockTranscriptPath,
	getGeminiMockTranscriptPath,
	getGeminiRoot,
} from "../../fixtures/agent-paths";

export interface DriverSignalFixture {
	readonly name: string;
	readonly payload: unknown;
	readonly expectedFactType: AgentFact["type"];
}

export interface DriverFixtures {
	readonly nativeSignals: readonly DriverSignalFixture[];
	readonly observation: {
		readonly expectedMessages: readonly {
			readonly role: "user" | "assistant" | "system";
			readonly text: string;
		}[];
	};
	readonly identity: {
		readonly card: DriverSessionRef;
		readonly overseer: DriverSessionRef;
		readonly generation: number;
	};
}

export function applySignalsBySeq(signals: readonly SessionSignal[]): readonly SessionSignal[] {
	const applied: SessionSignal[] = [];
	let lastSeq = 0;
	for (const signal of signals) {
		if (signal.seq <= lastSeq) {
			continue;
		}
		applied.push(signal);
		lastSeq = signal.seq;
	}
	return applied;
}

export interface DriverIntegrationDiffScope {
	readonly driverId: string;
	readonly changedFiles: readonly string[];
}

export function findDriverIntegrationScopeViolations(input: DriverIntegrationDiffScope): readonly string[] {
	const allowedFiles = new Set(["src/agents/driver.ts", "src/core/api-contract.ts", "test/agents/tck/driver-tck.ts"]);
	const driverPrefix = `src/agents/${input.driverId}/`;
	const fixturePrefix = `test/agents/tck/fixtures/${input.driverId}/`;

	return input.changedFiles.filter(
		(file) => !file.startsWith(driverPrefix) && !file.startsWith(fixturePrefix) && !allowedFiles.has(file),
	);
}

export function describeDriverTck(driver: AgentDriver, fixtures: DriverFixtures): void {
	describe(`${driver.id} AgentDriver TCK`, () => {
		it.skipIf(driver.catalog.binary === "fake-agent")(
			"givenAgentSessionWhenLocatedByIdThenTheDriverReturnsItsArtifactPath",
			async () => {
				const tempHome = mkdtempSync(join(tmpdir(), `tck-locate-${driver.id}-`));
				const sessionId = "12345678-abcd-ef01-2345-6789abcdef01";

				try {
					// Assert missing one resolves to null rather than throwing
					const missingPath = await driver.observe.artifactPath({ sessionId, homePath: tempHome });
					expect(missingPath).toBeNull();

					// Seed a fixture home in each driver's real layout
					if (driver.id === "claude") {
						const filePath = getClaudeMockTranscriptPath(tempHome, sessionId, "default");
						mkdirSync(dirname(filePath), { recursive: true });
						writeFileSync(filePath, "{}");
					} else if (driver.id === "codex") {
						const filePath = getCodexMockTranscriptPath(
							tempHome,
							sessionId,
							"2026/07/31",
							`rollout-2026-07-31T12-00-00-${sessionId}.jsonl`,
						);
						mkdirSync(dirname(filePath), { recursive: true });
						writeFileSync(filePath, "{}");
					} else if (driver.id === "gemini") {
						const filePath = getGeminiMockTranscriptPath(
							tempHome,
							sessionId,
							"default",
							`session-12345678-${sessionId}.jsonl`,
						);
						mkdirSync(dirname(filePath), { recursive: true });
						writeFileSync(filePath, "{}");
					}

					const foundPath = await driver.observe.artifactPath({ sessionId, homePath: tempHome });
					expect(foundPath).not.toBeNull();
					if (foundPath) {
						expect(existsSync(foundPath)).toBe(true);
					}
				} finally {
					rmSync(tempHome, { recursive: true, force: true });
				}
			},
		);

		it.skipIf(driver.catalog.binary === "fake-agent")(
			"givenSymlinkedWorkspacePathWhenSessionIsDiscoveredThenItStillMatches",
			async () => {
				const tempHome = mkdtempSync(join(tmpdir(), `tck-discover-${driver.id}-`));
				const sessionId = "87654321-abcd-ef01-2345-6789abcdef01";

				// Create a real directory and a symlink pointing to it
				const realDir = join(tempHome, "real-workspace");
				const symlinkDir = join(tempHome, "symlinked-workspace");
				mkdirSync(realDir, { recursive: true });
				symlinkSync(realDir, symlinkDir);

				try {
					if (driver.id === "claude") {
						// Claude doesn't support discovery, should resolve to null
						const discovered = await driver.observe.discoverSession({
							cwd: symlinkDir,
							startedAtMs: Date.now(),
							homePath: tempHome,
						});
						expect(discovered).toBeNull();
					} else if (driver.id === "codex") {
						// Codex records the realDir, but we query with symlinkDir
						const rolloutFile = getCodexMockTranscriptPath(
							tempHome,
							sessionId,
							"2026/07/31",
							`rollout-2026-07-31T12-00-00-${sessionId}.jsonl`,
						);
						mkdirSync(dirname(rolloutFile), { recursive: true });
						writeFileSync(rolloutFile, `${JSON.stringify({ type: "session_meta", cwd: realDir })}\n`, "utf8");

						const discovered = await driver.observe.discoverSession({
							cwd: symlinkDir,
							startedAtMs: Date.now() - 5000,
							homePath: tempHome,
						});
						expect(discovered).toBe(sessionId);
					} else if (driver.id === "gemini") {
						// Gemini records the realDir in projects.json (or .project_root), but we query with symlinkDir
						const geminiRoot = getGeminiRoot(tempHome);
						const tmpRoot = join(geminiRoot, "tmp");
						const slug = "workspace-slug";
						const chatsDir = join(tmpRoot, slug, "chats");
						mkdirSync(chatsDir, { recursive: true });

						// Write projects.json containing realDir
						const projectsJsonPath = join(geminiRoot, "projects.json");
						writeFileSync(
							projectsJsonPath,
							JSON.stringify({
								projects: {
									[realDir]: slug,
								},
							}),
							"utf8",
						);

						// Write a chats file
						const chatFile = join(chatsDir, `session-12345678-${sessionId}.jsonl`);
						writeFileSync(chatFile, `${JSON.stringify({ sessionId })}\n`, "utf8");

						const discovered = await driver.observe.discoverSession({
							cwd: symlinkDir,
							startedAtMs: Date.now() - 5000,
							homePath: tempHome,
						});
						expect(discovered).toBe(sessionId);
					}
				} finally {
					rmSync(tempHome, { recursive: true, force: true });
				}
			},
		);

		it("maps every fixture signal into the declared AgentFact vocabulary", () => {
			const mapped = fixtures.nativeSignals.map((fixture) =>
				driver.signals.mapNativeSignal({
					name: fixture.name,
					payload: fixture.payload,
					observedAt: 1_000,
				}),
			);

			expect(mapped.every((result) => result.supported)).toBe(true);
			expect(
				mapped.map((result) => {
					if (!result.supported) {
						return null;
					}
					return result.value.fact.type;
				}),
			).toEqual(fixtures.nativeSignals.map((fixture) => fixture.expectedFactType));
		});

		it("keeps turn end and attention-required signals separate", () => {
			const mapped = fixtures.nativeSignals.map((fixture) =>
				driver.signals.mapNativeSignal({
					name: fixture.name,
					payload: fixture.payload,
					observedAt: 1_000,
				}),
			);
			const facts = mapped.flatMap((result) => (result.supported ? [result.value.fact] : []));
			const attentionResult = driver.signals.attentionSupport();

			expect(facts.some((fact) => fact.type === "turn.ended")).toBe(true);
			if (attentionResult.supported) {
				expect(facts.some((fact) => fact.type === "attention.required")).toBe(true);
			} else {
				expect(attentionResult.reason.trim().length).toBeGreaterThan(0);
			}
			expect(facts.find((fact) => fact.type === "turn.ended")).not.toEqual(
				facts.find((fact) => fact.type === "attention.required"),
			);
		});

		it("applies a replayed seq only once", () => {
			const first = fixtures.nativeSignals[0];
			expect(first).toBeDefined();
			const signal = mapFixtureSignal(driver, first);
			const replayed = mapFixtureSignal(driver, first);

			expect(replayed.seq).toBe(signal.seq);
			expect(applySignalsBySeq([signal, replayed])).toEqual([signal]);
		});

		it("drops signals older than the last applied seq", () => {
			const olderFixture = fixtures.nativeSignals[0];
			const newerFixture = fixtures.nativeSignals[1];
			expect(olderFixture).toBeDefined();
			expect(newerFixture).toBeDefined();
			const olderSignal = mapFixtureSignal(driver, olderFixture);
			const newerSignal = mapFixtureSignal(driver, newerFixture);

			expect(olderSignal.seq).toBeLessThan(newerSignal.seq);
			expect(applySignalsBySeq([newerSignal, olderSignal])).toEqual([newerSignal]);
		});

		it("round-trips observation into non-empty correctly roled messages", async () => {
			const messages = await driver.observe.messages();

			expect(messages.supported).toBe(true);
			if (!messages.supported) {
				return;
			}
			expect(messages.value).toEqual(fixtures.observation.expectedMessages);
			expect(messages.value.length).toBeGreaterThan(0);
			expect(messages.value.every((message) => message.text.trim().length > 0)).toBe(true);
		});

		it("round-trips identity and makes overseer durability explicit", () => {
			const cardPlan = driver.identity.resolve({
				ref: fixtures.identity.card,
				stored: null,
				lifecycle: "gone",
				generation: fixtures.identity.generation,
			});
			const overseerPlan = driver.identity.resolve({
				ref: fixtures.identity.overseer,
				stored: null,
				lifecycle: "gone",
				generation: fixtures.identity.generation,
			});

			expect(cardPlan.supported).toBe(true);
			if (overseerPlan.supported) {
				expect(overseerPlan.value.durability).toBe(driver.identity.durability);
				if (driver.identity.durability === "deterministic") {
					const replayedOverseerPlan = driver.identity.resolve({
						ref: fixtures.identity.overseer,
						stored: null,
						lifecycle: "gone",
						generation: fixtures.identity.generation,
					});

					expect(replayedOverseerPlan.supported).toBe(true);
					if (replayedOverseerPlan.supported) {
						expect(replayedOverseerPlan.value.agentSessionId).toBe(overseerPlan.value.agentSessionId);
					}
				}
			} else {
				expect(overseerPlan.reason.trim().length).toBeGreaterThan(0);
			}
		});

		it("supports control steer with submit enabled and disabled", async () => {
			const text = "PING-42";
			const steerWithSubmit = await driver.control.steer({ text, submit: true });
			expect(steerWithSubmit.supported).toBe(true);
			if (steerWithSubmit.supported) {
				const plan = steerWithSubmit.value;
				expect(plan.length).toBeGreaterThan(0);
				expect(plan[0]?.type).toBe("write");
				expect(plan.some((step) => step.type === "wait")).toBe(true);
				expect(plan.some((step) => step.type === "write" && step.data === "\r")).toBe(true);
			}

			const steerWithoutSubmit = await driver.control.steer({ text, submit: false });
			expect(steerWithoutSubmit.supported).toBe(true);
			if (steerWithoutSubmit.supported) {
				const plan = steerWithoutSubmit.value;
				expect(plan.length).toBeGreaterThan(0);
				expect(plan[0]?.type).toBe("write");
				expect(plan.some((step) => step.type === "wait")).toBe(false);
				expect(plan.some((step) => step.type === "write" && step.data === "\r")).toBe(false);
			}
		});

		it("either performs interrupt or fails with a non-empty reason", async () => {
			const interrupt = await driver.control.interrupt();
			if (interrupt.supported) {
				const plan = interrupt.value;
				expect(plan.length).toBeGreaterThan(0);
				expect(plan.every((step) => step.type === "write" || step.type === "wait")).toBe(true);
			} else {
				expect(interrupt.reason.trim().length).toBeGreaterThan(0);
			}
		});
	});
}

function mapFixtureSignal(driver: AgentDriver, fixture: DriverSignalFixture): SessionSignal {
	const mapped = driver.signals.mapNativeSignal({
		name: fixture.name,
		payload: fixture.payload,
		observedAt: 1_000,
	});
	expect(mapped.supported).toBe(true);
	if (!mapped.supported) {
		throw new Error(mapped.reason);
	}
	return mapped.value;
}
