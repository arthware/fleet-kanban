import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { clineHomeDir } from "../config/cline-home";
import { lockedFileSystem } from "../fs/locked-file-system";
import { locateAgentTranscript } from "../terminal/agent-transcript-locator";
import { readAgentUsage } from "../terminal/agent-usage-reader";
import type { RuntimeTaskTokenUsage } from "./api-contract";
import { isHomeAgentSessionId } from "./home-agent-session";

export interface SessionLedgerManifest {
	readonly schemaVersion: 1;
	readonly taskId: string;
	readonly kind: "home-agent" | "card";
	readonly generation: number;
	readonly agentId: string;
	readonly agentSessionId: string | null;
	readonly openedAt: number;
	readonly closedAt: number | null;
	readonly outcome: "completed" | "failed" | "interrupted" | "unknown";
	readonly usage: RuntimeTaskTokenUsage;
	readonly source: {
		readonly artifactPath: string | null;
		readonly artifactSeenAt: number | null;
		readonly artifactMtimeMs: number | null;
		readonly artifactBytes: number | null;
	};
	readonly body: {
		readonly captured: boolean;
		readonly capturedAt: number | null;
		readonly messageCount: number;
		readonly bytes: number;
		readonly truncated: boolean;
	};
}

export interface SessionLedgerIndex {
	readonly schemaVersion: 1;
	readonly taskId: string;
	readonly generations: readonly {
		readonly generation: number;
		readonly openedAt: number;
		readonly closedAt: number | null;
		readonly agentId: string;
	}[];
}

export interface HarvestResult {
	readonly workspaceId: string;
	readonly taskId: string;
	readonly agentSessionId: string;
	readonly alreadyExisted: boolean;
	readonly artifactPresent: boolean;
}

export function getWorkspaceDir(workspaceId: string): string {
	return join(clineHomeDir(), "kanban", "workspaces", workspaceId);
}

export function getTaskSessionsDir(workspaceId: string, taskId: string): string {
	return join(getWorkspaceDir(workspaceId), "sessions", taskId);
}

export async function openSession(params: {
	workspaceId: string;
	taskId: string;
	kind: "home-agent" | "card";
	generation: number;
	agentId: string;
	agentSessionId: string | null;
	openedAt?: number;
}): Promise<SessionLedgerManifest> {
	const sessionsDir = getTaskSessionsDir(params.workspaceId, params.taskId);
	const genDir = join(sessionsDir, String(params.generation));
	const manifestPath = join(genDir, "manifest.json");

	await mkdir(genDir, { recursive: true });

	let existingManifest: SessionLedgerManifest | null = null;
	try {
		const raw = await readFile(manifestPath, "utf8");
		existingManifest = JSON.parse(raw) as SessionLedgerManifest;
	} catch {
		// Does not exist or unreadable
	}

	let manifest: SessionLedgerManifest;
	if (existingManifest) {
		if (existingManifest.agentSessionId === null && params.agentSessionId !== null) {
			manifest = {
				...existingManifest,
				agentSessionId: params.agentSessionId,
			};
			await lockedFileSystem.writeJsonFileAtomic(manifestPath, manifest);
		} else {
			manifest = existingManifest;
		}
	} else {
		manifest = {
			schemaVersion: 1,
			taskId: params.taskId,
			kind: params.kind,
			generation: params.generation,
			agentId: params.agentId,
			agentSessionId: params.agentSessionId,
			openedAt: params.openedAt ?? Date.now(),
			closedAt: null,
			outcome: "unknown",
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: null,
			},
			source: {
				artifactPath: null,
				artifactSeenAt: null,
				artifactMtimeMs: null,
				artifactBytes: null,
			},
			body: {
				captured: false,
				capturedAt: null,
				messageCount: 0,
				bytes: 0,
				truncated: false,
			},
		};
		await lockedFileSystem.writeJsonFileAtomic(manifestPath, manifest);
	}

	await updateIndex(params.workspaceId, params.taskId, manifest);

	return manifest;
}

async function updateIndex(workspaceId: string, taskId: string, manifest: SessionLedgerManifest): Promise<void> {
	const sessionsDir = getTaskSessionsDir(workspaceId, taskId);
	const indexPath = join(sessionsDir, "index.json");

	let index: SessionLedgerIndex | null = null;
	try {
		const raw = await readFile(indexPath, "utf8");
		index = JSON.parse(raw) as SessionLedgerIndex;
	} catch {
		// missing or unreadable
	}

	if (!index || index.schemaVersion !== 1 || index.taskId !== taskId) {
		index = {
			schemaVersion: 1,
			taskId,
			generations: [],
		};
	}

	const existingGenIdx = index.generations.findIndex((g) => g.generation === manifest.generation);
	const genEntry = {
		generation: manifest.generation,
		openedAt: manifest.openedAt,
		closedAt: manifest.closedAt,
		agentId: manifest.agentId,
	};

	const nextGenerations = [...index.generations];
	if (existingGenIdx >= 0) {
		nextGenerations[existingGenIdx] = genEntry;
	} else {
		nextGenerations.push(genEntry);
	}

	nextGenerations.sort((a, b) => a.generation - b.generation);

	index = {
		...index,
		generations: nextGenerations,
	};

	await lockedFileSystem.writeJsonFileAtomic(indexPath, index);
}

export async function listSessions(workspaceId: string, taskId: string): Promise<SessionLedgerIndex | null> {
	const sessionsDir = getTaskSessionsDir(workspaceId, taskId);
	const indexPath = join(sessionsDir, "index.json");

	let index: SessionLedgerIndex | null = null;
	try {
		const raw = await readFile(indexPath, "utf8");
		index = JSON.parse(raw) as SessionLedgerIndex;
	} catch {
		// Missing or corrupt
	}

	if (index && index.schemaVersion === 1 && index.taskId === taskId) {
		return index;
	}

	try {
		const entries = await readdir(sessionsDir, { withFileTypes: true });
		const generations: Array<{
			generation: number;
			openedAt: number;
			closedAt: number | null;
			agentId: string;
		}> = [];

		for (const entry of entries) {
			if (entry.isDirectory()) {
				const genNum = Number.parseInt(entry.name, 10);
				if (!Number.isNaN(genNum)) {
					const manifestPath = join(sessionsDir, entry.name, "manifest.json");
					try {
						const rawManifest = await readFile(manifestPath, "utf8");
						const manifest = JSON.parse(rawManifest) as SessionLedgerManifest;
						generations.push({
							generation: manifest.generation,
							openedAt: manifest.openedAt,
							closedAt: manifest.closedAt,
							agentId: manifest.agentId,
						});
					} catch {
						// Skip if directory has no valid manifest
					}
				}
			}
		}

		if (generations.length === 0) {
			return null;
		}

		generations.sort((a, b) => a.generation - b.generation);

		const reconstructedIndex: SessionLedgerIndex = {
			schemaVersion: 1,
			taskId,
			generations,
		};

		await lockedFileSystem.writeJsonFileAtomic(indexPath, reconstructedIndex);
		return reconstructedIndex;
	} catch {
		return null;
	}
}

async function deriveArtifactDetails(
	agentId: string,
	sessionId: string,
	usageOut: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
		costUsd: number | null;
	},
	sourceOut: {
		artifactPath: string | null;
		artifactSeenAt: number | null;
		artifactMtimeMs: number | null;
		artifactBytes: number | null;
	},
): Promise<boolean> {
	try {
		const transcriptLoc = await locateAgentTranscript({
			agentId,
			sessionId,
			homePath: homedir(),
		});

		if (transcriptLoc.present) {
			sourceOut.artifactPath = transcriptLoc.path;
			sourceOut.artifactSeenAt = Date.now();
			try {
				const stats = await stat(transcriptLoc.path);
				sourceOut.artifactMtimeMs = stats.mtimeMs;
				sourceOut.artifactBytes = stats.size;
			} catch {
				// Ignore stat errors
			}

			const usageResult = await readAgentUsage({
				agentId,
				sessionId,
				homePath: homedir(),
			});

			if (usageResult.present && usageResult.usage) {
				usageOut.inputTokens = usageResult.usage.inputTokens;
				usageOut.outputTokens = usageResult.usage.outputTokens;
				usageOut.cacheReadTokens = usageResult.usage.cacheReadTokens;
				usageOut.cacheCreationTokens = usageResult.usage.cacheCreationTokens;
				usageOut.costUsd = usageResult.usage.costUsd;
			}
			return true;
		}
	} catch {
		// Ignore errors
	}
	return false;
}

export async function harvestSessions(options?: { dryRun?: boolean }): Promise<readonly HarvestResult[]> {
	const workspacesDir = join(clineHomeDir(), "kanban", "workspaces");
	const indexPath = join(workspacesDir, "index.json");

	let indexFile: any;
	try {
		const raw = await readFile(indexPath, "utf8");
		indexFile = JSON.parse(raw);
	} catch {
		return [];
	}

	if (!indexFile || !indexFile.entries) {
		return [];
	}

	const results: HarvestResult[] = [];

	for (const workspaceId of Object.keys(indexFile.entries)) {
		const sessionsPath = join(workspacesDir, workspaceId, "sessions.json");
		let sessions: Record<string, any>;
		try {
			const raw = await readFile(sessionsPath, "utf8");
			sessions = JSON.parse(raw);
		} catch {
			continue;
		}

		if (!sessions || typeof sessions !== "object") {
			continue;
		}

		for (const [taskId, summary] of Object.entries(sessions)) {
			const agentSessionId = summary.agentSessionId;
			if (!agentSessionId) {
				continue;
			}

			const kind = isHomeAgentSessionId(taskId) ? "home-agent" : "card";
			const generation =
				kind === "home-agent" ? (summary.sessionGeneration ?? summary.homeAgentSessionGeneration ?? 0) : 0;
			const agentId = summary.agentId ?? "claude";

			const sessionsDir = getTaskSessionsDir(workspaceId, taskId);
			const genDir = join(sessionsDir, String(generation));
			const manifestPath = join(genDir, "manifest.json");

			let alreadyExisted = false;
			try {
				await stat(manifestPath);
				alreadyExisted = true;
			} catch {
				// doesn't exist
			}

			const usage = {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: null,
			};
			const source = {
				artifactPath: null,
				artifactSeenAt: null,
				artifactMtimeMs: null,
				artifactBytes: null,
			};

			const artifactPresent = await deriveArtifactDetails(agentId, agentSessionId, usage, source);

			if (!options?.dryRun) {
				if (!alreadyExisted) {
					await mkdir(genDir, { recursive: true });
					const manifest: SessionLedgerManifest = {
						schemaVersion: 1,
						taskId,
						kind,
						generation,
						agentId,
						agentSessionId,
						openedAt: summary.startedAt ?? summary.updatedAt,
						closedAt: summary.updatedAt,
						outcome: "unknown",
						usage,
						source,
						body: {
							captured: false,
							capturedAt: null,
							messageCount: 0,
							bytes: 0,
							truncated: false,
						},
					};
					await lockedFileSystem.writeJsonFileAtomic(manifestPath, manifest);
					await updateIndex(workspaceId, taskId, manifest);
				}
			}

			results.push({
				workspaceId,
				taskId,
				agentSessionId,
				alreadyExisted,
				artifactPresent,
			});
		}
	}

	return results;
}
