import type {
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeGitSyncSummary,
	RuntimeTaskWorkspaceMetadata,
	RuntimeWorkspaceMetadata,
} from "../core/api-contract";
import type { CardPrRef } from "../workspace/card-pr-url";
import { resolveCardPrUrl } from "../workspace/card-pr-url";
import { getGitSyncSummary, probeGitWorkspaceState } from "../workspace/git-sync";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";

const WORKSPACE_METADATA_POLL_INTERVAL_MS = 1_000;
const WORKSPACE_PR_CAPTURE_INTERVAL_MS = 10_000;
// A card that reaches review without a PR yet is re-checked at most this often,
// so a review card lacking a pushed PR does not spawn a `gh` subprocess on every
// one-second poll. Capturing a found PR is idempotent and never re-runs.
const PR_RESOLVE_RETRY_INTERVAL_MS = 30_000;

interface TrackedTaskWorkspace {
	taskId: string;
	baseRef: string;
	columnId: RuntimeBoardColumnId;
	hasStoredPrUrl: boolean;
}

interface CachedHomeGitMetadata {
	summary: RuntimeGitSyncSummary | null;
	stateToken: string | null;
	stateVersion: number;
}

interface CachedTaskWorkspaceMetadata {
	data: RuntimeTaskWorkspaceMetadata;
	stateToken: string | null;
}

interface WorkspaceMetadataEntry {
	workspaceId: string;
	workspacePath: string;
	trackedTasks: TrackedTaskWorkspace[];
	subscriberCount: number;
	pollTimer: NodeJS.Timeout | null;
	prCaptureTimer: NodeJS.Timeout | null;
	refreshPromise: Promise<RuntimeWorkspaceMetadata> | null;
	prCapturePromise: Promise<void> | null;
	homeGit: CachedHomeGitMetadata;
	taskMetadataByTaskId: Map<string, CachedTaskWorkspaceMetadata>;
	// Task ids whose PR we have already captured this session, so we never
	// re-resolve or re-persist after the first detection.
	capturedPrTaskIds: Set<string>;
	// Last `gh` resolve attempt per task id (epoch ms), throttling review cards
	// that do not have a PR yet — see PR_RESOLVE_RETRY_INTERVAL_MS.
	prResolveAttemptedAtByTaskId: Map<string, number>;
}

export interface WorkspaceMetadataCardPrCapture {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
	pr: CardPrRef;
}

export interface CreateWorkspaceMetadataMonitorDependencies {
	onMetadataUpdated: (workspaceId: string, metadata: RuntimeWorkspaceMetadata) => void;
	// Resolve the GitHub PR a review card's branch led to. Injectable so tests can
	// avoid spawning `gh`; defaults to the real gh-backed resolver.
	resolveCardPr?: (input: { branch: string; cwd: string }) => Promise<CardPrRef | null>;
	// Persist a first-detected PR onto the card in board.json. Absent in contexts
	// that do not persist (e.g. lightweight tests) — capture is then skipped.
	persistCardPr?: (capture: WorkspaceMetadataCardPrCapture) => Promise<void>;
}

export interface WorkspaceMetadataMonitor {
	connectWorkspace: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeWorkspaceMetadata>;
	updateWorkspaceState: (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}) => Promise<RuntimeWorkspaceMetadata>;
	disconnectWorkspace: (workspaceId: string) => void;
	disposeWorkspace: (workspaceId: string) => void;
	close: () => void;
}

function collectTrackedTasks(board: RuntimeBoardData): TrackedTaskWorkspace[] {
	const tracked: TrackedTaskWorkspace[] = [];
	for (const column of board.columns) {
		// Backlog and trash cards do not need git metadata polling. Tracking only
		// active columns avoids unnecessary work, and trash paths are reconstructed
		// from task id on the web-ui side.
		if (column.id === "backlog" || column.id === "trash") {
			continue;
		}
		for (const card of column.cards) {
			tracked.push({
				taskId: card.id,
				baseRef: card.baseRef,
				columnId: column.id,
				hasStoredPrUrl: typeof card.prUrl === "string" && card.prUrl.length > 0,
			});
		}
	}
	return tracked;
}

function areGitSummariesEqual(a: RuntimeGitSyncSummary | null, b: RuntimeGitSyncSummary | null): boolean {
	if (a === b) {
		return true;
	}
	if (!a || !b) {
		return false;
	}
	return (
		a.currentBranch === b.currentBranch &&
		a.upstreamBranch === b.upstreamBranch &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.aheadCount === b.aheadCount &&
		a.behindCount === b.behindCount
	);
}

function areTaskMetadataEqual(a: RuntimeTaskWorkspaceMetadata, b: RuntimeTaskWorkspaceMetadata): boolean {
	return (
		a.taskId === b.taskId &&
		a.path === b.path &&
		a.exists === b.exists &&
		a.baseRef === b.baseRef &&
		a.branch === b.branch &&
		a.isDetached === b.isDetached &&
		a.headCommit === b.headCommit &&
		a.changedFiles === b.changedFiles &&
		a.additions === b.additions &&
		a.deletions === b.deletions &&
		a.stateVersion === b.stateVersion
	);
}

function areWorkspaceMetadataEqual(a: RuntimeWorkspaceMetadata, b: RuntimeWorkspaceMetadata): boolean {
	if (!areGitSummariesEqual(a.homeGitSummary, b.homeGitSummary)) {
		return false;
	}
	if (a.homeGitStateVersion !== b.homeGitStateVersion) {
		return false;
	}
	if (a.taskWorkspaces.length !== b.taskWorkspaces.length) {
		return false;
	}
	for (let index = 0; index < a.taskWorkspaces.length; index += 1) {
		const left = a.taskWorkspaces[index];
		const right = b.taskWorkspaces[index];
		if (!left || !right || !areTaskMetadataEqual(left, right)) {
			return false;
		}
	}
	return true;
}

function createEmptyWorkspaceMetadata(): RuntimeWorkspaceMetadata {
	return {
		homeGitSummary: null,
		homeGitStateVersion: 0,
		taskWorkspaces: [],
	};
}

function createWorkspaceEntry(workspaceId: string, workspacePath: string): WorkspaceMetadataEntry {
	return {
		workspaceId,
		workspacePath,
		trackedTasks: [],
		capturedPrTaskIds: new Set<string>(),
		prResolveAttemptedAtByTaskId: new Map<string, number>(),
		subscriberCount: 0,
		pollTimer: null,
		prCaptureTimer: null,
		refreshPromise: null,
		prCapturePromise: null,
		homeGit: {
			summary: null,
			stateToken: null,
			stateVersion: 0,
		},
		taskMetadataByTaskId: new Map<string, CachedTaskWorkspaceMetadata>(),
	};
}

function buildWorkspaceMetadataSnapshot(entry: WorkspaceMetadataEntry): RuntimeWorkspaceMetadata {
	return {
		homeGitSummary: entry.homeGit.summary,
		homeGitStateVersion: entry.homeGit.stateVersion,
		taskWorkspaces: entry.trackedTasks
			.map((task) => entry.taskMetadataByTaskId.get(task.taskId)?.data ?? null)
			.filter((task): task is RuntimeTaskWorkspaceMetadata => task !== null),
	};
}

async function loadHomeGitMetadata(entry: WorkspaceMetadataEntry): Promise<CachedHomeGitMetadata> {
	try {
		const probe = await probeGitWorkspaceState(entry.workspacePath);
		if (entry.homeGit.stateToken === probe.stateToken) {
			return entry.homeGit;
		}
		const summary = await getGitSyncSummary(entry.workspacePath, { probe });
		return {
			summary,
			stateToken: probe.stateToken,
			stateVersion: Date.now(),
		};
	} catch {
		return entry.homeGit;
	}
}

async function loadTaskWorkspaceMetadata(
	workspacePath: string,
	task: TrackedTaskWorkspace,
	current: CachedTaskWorkspaceMetadata | null,
): Promise<CachedTaskWorkspaceMetadata | null> {
	const pathInfo = await getTaskWorkspacePathInfo({
		cwd: workspacePath,
		taskId: task.taskId,
		baseRef: task.baseRef,
	});

	if (!pathInfo.exists) {
		if (
			current &&
			current.data.exists === false &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef
		) {
			return current;
		}
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: false,
				baseRef: pathInfo.baseRef,
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				stateVersion: Date.now(),
			},
			stateToken: null,
		};
	}

	try {
		const probe = await probeGitWorkspaceState(pathInfo.path);
		if (
			current &&
			current.stateToken === probe.stateToken &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef
		) {
			return current;
		}
		const summary = await getGitSyncSummary(pathInfo.path, { probe });
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: true,
				baseRef: pathInfo.baseRef,
				branch: probe.currentBranch,
				isDetached: probe.headCommit !== null && probe.currentBranch === null,
				headCommit: probe.headCommit,
				changedFiles: summary.changedFiles,
				additions: summary.additions,
				deletions: summary.deletions,
				stateVersion: Date.now(),
			},
			stateToken: probe.stateToken,
		};
	} catch {
		if (current) {
			return current;
		}
		return {
			data: {
				taskId: task.taskId,
				path: pathInfo.path,
				exists: true,
				baseRef: pathInfo.baseRef,
				branch: null,
				isDetached: false,
				headCommit: null,
				changedFiles: null,
				additions: null,
				deletions: null,
				stateVersion: Date.now(),
			},
			stateToken: null,
		};
	}
}

export function createWorkspaceMetadataMonitor(
	deps: CreateWorkspaceMetadataMonitorDependencies,
): WorkspaceMetadataMonitor {
	const workspaces = new Map<string, WorkspaceMetadataEntry>();
	const resolveCardPr = deps.resolveCardPr ?? ((input) => resolveCardPrUrl(input));

	const captureTrackedCardPr = async (
		entry: WorkspaceMetadataEntry,
		task: TrackedTaskWorkspace,
		metadata: RuntimeTaskWorkspaceMetadata | null,
		options?: { ignoreRetryThrottle?: boolean },
	): Promise<void> => {
		if (task.hasStoredPrUrl || entry.capturedPrTaskIds.has(task.taskId)) {
			return;
		}
		if (!metadata || !metadata.exists || !metadata.branch) {
			return;
		}
		const now = Date.now();
		const lastAttemptAt = entry.prResolveAttemptedAtByTaskId.get(task.taskId) ?? 0;
		if (!options?.ignoreRetryThrottle && now - lastAttemptAt < PR_RESOLVE_RETRY_INTERVAL_MS) {
			return;
		}
		entry.prResolveAttemptedAtByTaskId.set(task.taskId, now);

		let pr: CardPrRef | null = null;
		try {
			pr = await resolveCardPr({ branch: metadata.branch, cwd: metadata.path });
		} catch {
			pr = null;
		}
		if (!pr) {
			return;
		}

		// Mark captured before persisting so a concurrent refresh cannot
		// double-resolve; roll back on failure so a later refresh can retry.
		entry.capturedPrTaskIds.add(task.taskId);
		try {
			await deps.persistCardPr?.({
				workspaceId: entry.workspaceId,
				workspacePath: entry.workspacePath,
				taskId: task.taskId,
				pr,
			});
		} catch {
			entry.capturedPrTaskIds.delete(task.taskId);
		}
	};

	// Capture the PR of any review card whose branch now leads to one, exactly
	// once. Never throws — a gh/persist failure just means "retry on a later
	// capture window; no link yet".
	const captureTrackedCardPrs = async (entry: WorkspaceMetadataEntry): Promise<void> => {
		if (!deps.persistCardPr) {
			return;
		}
		for (const task of entry.trackedTasks) {
			if (task.columnId !== "review") {
				continue;
			}
			const metadata = entry.taskMetadataByTaskId.get(task.taskId)?.data;
			await captureTrackedCardPr(entry, task, metadata ?? null);
		}
	};

	const stopWorkspaceTimer = (entry: WorkspaceMetadataEntry) => {
		if (!entry.pollTimer) {
			return;
		}
		clearInterval(entry.pollTimer);
		entry.pollTimer = null;
	};

	const stopWorkspacePrCaptureTimer = (entry: WorkspaceMetadataEntry) => {
		if (!entry.prCaptureTimer) {
			return;
		}
		clearInterval(entry.prCaptureTimer);
		entry.prCaptureTimer = null;
	};

	const captureWorkspacePrs = async (workspaceId: string): Promise<void> => {
		const entry = workspaces.get(workspaceId);
		if (!entry || !deps.persistCardPr) {
			return;
		}
		if (entry.prCapturePromise) {
			return await entry.prCapturePromise;
		}

		entry.prCapturePromise = (async () => {
			const nextTaskEntries = await Promise.all(
				entry.trackedTasks.map(async (task) => {
					if (task.columnId !== "review" || task.hasStoredPrUrl || entry.capturedPrTaskIds.has(task.taskId)) {
						return null;
					}
					const current = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
					const next = await loadTaskWorkspaceMetadata(entry.workspacePath, task, current);
					return next ? ([task.taskId, next] satisfies [string, CachedTaskWorkspaceMetadata]) : null;
				}),
			);

			for (const nextTaskEntry of nextTaskEntries) {
				if (nextTaskEntry) {
					entry.taskMetadataByTaskId.set(nextTaskEntry[0], nextTaskEntry[1]);
				}
			}

			await captureTrackedCardPrs(entry);
		})().finally(() => {
			const current = workspaces.get(workspaceId);
			if (current) {
				current.prCapturePromise = null;
			}
		});

		await entry.prCapturePromise;
	};

	const captureReviewDoneTransitions = async (
		entry: WorkspaceMetadataEntry,
		previousTasks: TrackedTaskWorkspace[],
	): Promise<void> => {
		if (!deps.persistCardPr) {
			return;
		}
		const previousColumnByTaskId = new Map(previousTasks.map((task) => [task.taskId, task.columnId]));
		for (const task of entry.trackedTasks) {
			if (previousColumnByTaskId.get(task.taskId) !== "review" || task.columnId !== "done") {
				continue;
			}
			const current = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
			const next = await loadTaskWorkspaceMetadata(entry.workspacePath, task, current);
			if (next) {
				entry.taskMetadataByTaskId.set(task.taskId, next);
			}
			await captureTrackedCardPr(entry, task, next?.data ?? current?.data ?? null, {
				ignoreRetryThrottle: true,
			});
		}
	};

	const refreshWorkspace = async (workspaceId: string): Promise<RuntimeWorkspaceMetadata> => {
		const entry = workspaces.get(workspaceId);
		if (!entry) {
			return createEmptyWorkspaceMetadata();
		}
		if (entry.refreshPromise) {
			return await entry.refreshPromise;
		}

		entry.refreshPromise = (async () => {
			const previousSnapshot = buildWorkspaceMetadataSnapshot(entry);
			entry.homeGit = await loadHomeGitMetadata(entry);

			const nextTaskEntries = await Promise.all(
				entry.trackedTasks.map(async (task) => {
					const current = entry.taskMetadataByTaskId.get(task.taskId) ?? null;
					const next = await loadTaskWorkspaceMetadata(entry.workspacePath, task, current);
					return next ? [task.taskId, next] : null;
				}),
			);

			entry.taskMetadataByTaskId = new Map(
				nextTaskEntries.filter(
					(candidate): candidate is [string, CachedTaskWorkspaceMetadata] => candidate !== null,
				),
			);

			const nextSnapshot = buildWorkspaceMetadataSnapshot(entry);
			if (!areWorkspaceMetadataEqual(previousSnapshot, nextSnapshot)) {
				deps.onMetadataUpdated(workspaceId, nextSnapshot);
			}

			// Capture PRs after broadcasting so the gh lookup stays off the render path.
			await captureTrackedCardPrs(entry);

			return nextSnapshot;
		})().finally(() => {
			const current = workspaces.get(workspaceId);
			if (current) {
				current.refreshPromise = null;
			}
		});

		return await entry.refreshPromise;
	};

	const updateWorkspaceEntry = (input: {
		workspaceId: string;
		workspacePath: string;
		board: RuntimeBoardData;
	}): { entry: WorkspaceMetadataEntry; previousTasks: TrackedTaskWorkspace[] } => {
		const existing =
			workspaces.get(input.workspaceId) ?? createWorkspaceEntry(input.workspaceId, input.workspacePath);
		const previousTasks = existing.trackedTasks;
		existing.workspacePath = input.workspacePath;
		existing.trackedTasks = collectTrackedTasks(input.board);
		workspaces.set(input.workspaceId, existing);
		return { entry: existing, previousTasks };
	};

	const ensureWorkspaceTimer = (workspaceId: string, entry: WorkspaceMetadataEntry) => {
		if (entry.pollTimer) {
			return;
		}
		const timer = setInterval(() => {
			void refreshWorkspace(workspaceId);
		}, WORKSPACE_METADATA_POLL_INTERVAL_MS);
		timer.unref();
		entry.pollTimer = timer;
	};

	const ensureWorkspacePrCaptureTimer = (workspaceId: string, entry: WorkspaceMetadataEntry) => {
		if (entry.prCaptureTimer || !deps.persistCardPr) {
			return;
		}
		const timer = setInterval(() => {
			void captureWorkspacePrs(workspaceId);
		}, WORKSPACE_PR_CAPTURE_INTERVAL_MS);
		timer.unref();
		entry.prCaptureTimer = timer;
	};

	return {
		connectWorkspace: async ({ workspaceId, workspacePath, board }) => {
			const { entry, previousTasks } = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			await captureReviewDoneTransitions(entry, previousTasks);
			entry.subscriberCount += 1;
			ensureWorkspacePrCaptureTimer(workspaceId, entry);
			ensureWorkspaceTimer(workspaceId, entry);
			return await refreshWorkspace(workspaceId);
		},
		updateWorkspaceState: async ({ workspaceId, workspacePath, board }) => {
			const { entry, previousTasks } = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			await captureReviewDoneTransitions(entry, previousTasks);
			ensureWorkspacePrCaptureTimer(workspaceId, entry);
			if (entry.subscriberCount === 0) {
				return buildWorkspaceMetadataSnapshot(entry);
			}
			return await refreshWorkspace(workspaceId);
		},
		disconnectWorkspace: (workspaceId) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) {
				return;
			}
			entry.subscriberCount = Math.max(0, entry.subscriberCount - 1);
			if (entry.subscriberCount > 0) {
				return;
			}
			stopWorkspaceTimer(entry);
		},
		disposeWorkspace: (workspaceId) => {
			const entry = workspaces.get(workspaceId);
			if (!entry) {
				return;
			}
			stopWorkspaceTimer(entry);
			stopWorkspacePrCaptureTimer(entry);
			workspaces.delete(workspaceId);
		},
		close: () => {
			for (const entry of workspaces.values()) {
				stopWorkspaceTimer(entry);
				stopWorkspacePrCaptureTimer(entry);
			}
			workspaces.clear();
		},
	};
}
