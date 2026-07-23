import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeCardPrGateStatus,
	RuntimeCardPrState,
	RuntimeGitSyncSummary,
	RuntimeTaskWorkspaceMetadata,
	RuntimeWorkspaceMetadata,
} from "../core/api-contract";
import { deriveTaskBranchName } from "../core/task-ref";
import type { CardPrRef } from "../workspace/card-pr-url";
import { listRepoCardPrsByHead } from "../workspace/card-pr-url";
import { computeGitDirToken } from "../workspace/git-dir-token";
import { getGitSyncSummary, probeGitWorkspaceState } from "../workspace/git-sync";
import { getTaskWorkspacePathInfo } from "../workspace/task-worktree";

export const WORKSPACE_METADATA_POLL_INTERVAL_MS = 1_000;
export const PR_STATE_REFRESH_MIN_MS = 60_000;
// A card that reaches review without a PR yet is re-checked at most this often,
// so a review card lacking a pushed PR does not spawn a `gh` subprocess on every
// one-second poll. Capturing a found PR is idempotent and never re-runs.
const PR_RESOLVE_RETRY_INTERVAL_MS = 30_000;

interface TrackedTaskWorkspace {
	taskId: string;
	baseRef: string;
	columnId: RuntimeBoardColumnId;
	branchName: string;
	hasStoredPrUrl: boolean;
	storedPrState: RuntimeCardPrState | null;
	storedPrGateStatus: RuntimeCardPrGateStatus | null;
}

interface CachedHomeGitMetadata {
	summary: RuntimeGitSyncSummary | null;
	stateToken: string | null;
	stateVersion: number;
	// Cheap fs-mtime token (see computeGitDirToken). When unchanged, the expensive
	// `git status` probe is skipped and the cached summary is reused.
	gitDirToken: string | null;
}

interface CachedTaskWorkspaceMetadata {
	data: RuntimeTaskWorkspaceMetadata;
	stateToken: string | null;
	// Cheap fs-mtime token (see computeGitDirToken). When unchanged and the worktree
	// is not actively being edited by a running agent, the `git status` probe is skipped.
	gitDirToken: string | null;
}

interface WorkspaceMetadataEntry {
	workspaceId: string;
	workspacePath: string;
	trackedTasks: TrackedTaskWorkspace[];
	subscriberCount: number;
	pollTimer: NodeJS.Timeout | null;
	refreshPromise: Promise<RuntimeWorkspaceMetadata> | null;
	homeGit: CachedHomeGitMetadata;
	taskMetadataByTaskId: Map<string, CachedTaskWorkspaceMetadata>;
	// Task ids whose PR we have already captured this session. Stored open PRs
	// still refresh below; terminal PRs stop because reopen handling is out of scope.
	capturedPrTaskIds: Set<string>;
	// Last `gh` resolve attempt per task id (epoch ms), throttling review cards
	// that do not have a PR yet — see PR_RESOLVE_RETRY_INTERVAL_MS.
	prResolveAttemptedAtByTaskId: Map<string, number>;
	// Last `gh` state refresh per task id (epoch ms), keeping stored open PR
	// re-resolution to at most once per PR_STATE_REFRESH_MIN_MS.
	lastPrCheckedAtByTaskId: Map<string, number>;
}

export interface WorkspaceMetadataCardPrCapture {
	workspaceId: string;
	workspacePath: string;
	taskId: string;
	pr: CardPrRef;
}

export interface CreateWorkspaceMetadataMonitorDependencies {
	onMetadataUpdated: (workspaceId: string, metadata: RuntimeWorkspaceMetadata) => void;
	// Resolve GitHub PRs for all branch heads in a repo in one bounded query.
	// Injectable so tests can avoid spawning `gh`; defaults to the real gh-backed resolver.
	resolveRepoCardPrs?: (input: { cwd: string }) => Promise<Map<string, CardPrRef>>;
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

function deriveTrackedTaskBranchName(card: RuntimeBoardCard): string {
	return deriveTaskBranchName({
		taskId: card.id,
		externalIssueKey: card.externalIssue?.key,
		title: card.title,
		prompt: card.prompt,
	});
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
				branchName: deriveTrackedTaskBranchName(card),
				hasStoredPrUrl: typeof card.prUrl === "string" && card.prUrl.length > 0,
				storedPrState: card.prState ?? null,
				storedPrGateStatus: card.prGateStatus ?? null,
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
		lastPrCheckedAtByTaskId: new Map<string, number>(),
		subscriberCount: 0,
		pollTimer: null,
		refreshPromise: null,
		homeGit: {
			summary: null,
			stateToken: null,
			stateVersion: 0,
			gitDirToken: null,
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
		// Cheap fs-mtime probe first: if git hasn't written to the repo since the last
		// poll, skip the full `git status` scan entirely and reuse the cached summary.
		const gitDirToken = await computeGitDirToken(entry.workspacePath);
		if (gitDirToken !== null && entry.homeGit.gitDirToken === gitDirToken) {
			return entry.homeGit;
		}
		const probe = await probeGitWorkspaceState(entry.workspacePath);
		if (entry.homeGit.stateToken === probe.stateToken) {
			// State unchanged but refresh the mtime token so the next tick can short-circuit.
			return { ...entry.homeGit, gitDirToken };
		}
		const summary = await getGitSyncSummary(entry.workspacePath, { probe });
		return {
			summary,
			stateToken: probe.stateToken,
			stateVersion: Date.now(),
			gitDirToken,
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
			gitDirToken: null,
		};
	}

	// Cheap fs-mtime probe: skip the expensive `git status` scan when nothing in .git
	// changed AND the worktree isn't being actively edited by a running agent. Unstaged
	// edits don't move .git mtimes, so an active (in_progress) card always falls through
	// to a full scan; idle/done cards only re-scan when git wrote (commit / checkout /
	// branch move), which the token catches.
	const gitDirToken = await computeGitDirToken(pathInfo.path);
	const isActive = task.columnId === "in_progress";
	if (
		current &&
		gitDirToken !== null &&
		current.gitDirToken === gitDirToken &&
		!isActive &&
		current.data.exists === true &&
		current.data.path === pathInfo.path &&
		current.data.baseRef === pathInfo.baseRef
	) {
		return current;
	}

	try {
		const probe = await probeGitWorkspaceState(pathInfo.path);
		if (
			current &&
			current.stateToken === probe.stateToken &&
			current.data.path === pathInfo.path &&
			current.data.baseRef === pathInfo.baseRef
		) {
			return { ...current, gitDirToken };
		}
		const summary = await getGitSyncSummary(pathInfo.path, { probe, baseRef: pathInfo.baseRef });
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
			gitDirToken,
		};
	} catch {
		if (current) {
			// Refresh the mtime token so an inactive card whose git call failed doesn't
			// re-probe on every tick; the cached data is preserved.
			return { ...current, gitDirToken };
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
			gitDirToken,
		};
	}
}

export function createWorkspaceMetadataMonitor(
	deps: CreateWorkspaceMetadataMonitorDependencies,
): WorkspaceMetadataMonitor {
	const workspaces = new Map<string, WorkspaceMetadataEntry>();
	const resolveRepoCardPrs = deps.resolveRepoCardPrs ?? ((input) => listRepoCardPrsByHead(input));

	const collectPrCandidates = (entry: WorkspaceMetadataEntry): TrackedTaskWorkspace[] => {
		const now = Date.now();
		const candidates: TrackedTaskWorkspace[] = [];
		for (const task of entry.trackedTasks) {
			if (task.hasStoredPrUrl) {
				if (task.storedPrState !== "open") {
					continue;
				}
				const lastCheckedAt = entry.lastPrCheckedAtByTaskId.get(task.taskId) ?? 0;
				if (now - lastCheckedAt < PR_STATE_REFRESH_MIN_MS) {
					continue;
				}
			} else {
				if (entry.capturedPrTaskIds.has(task.taskId)) {
					continue;
				}
				const lastAttemptAt = entry.prResolveAttemptedAtByTaskId.get(task.taskId) ?? 0;
				if (now - lastAttemptAt < PR_RESOLVE_RETRY_INTERVAL_MS) {
					continue;
				}
			}
			candidates.push(task);
		}
		return candidates;
	};

	const persistTrackedCardPr = async (
		entry: WorkspaceMetadataEntry,
		task: TrackedTaskWorkspace,
		pr: CardPrRef,
	): Promise<void> => {
		const wasMissingPr = !task.hasStoredPrUrl;
		if (wasMissingPr) {
			// Mark captured before persisting so a concurrent refresh cannot
			// double-resolve; roll back on failure so a later refresh can retry.
			entry.capturedPrTaskIds.add(task.taskId);
		}
		try {
			await deps.persistCardPr?.({
				workspaceId: entry.workspaceId,
				workspacePath: entry.workspacePath,
				taskId: task.taskId,
				pr,
			});
		} catch {
			if (wasMissingPr) {
				entry.capturedPrTaskIds.delete(task.taskId);
			}
		}
	};

	// Capture any tracked card whose deterministic branch has a PR, and refresh stored
	// open PRs until they become terminal. Never throws — a gh/persist failure just
	// means "retry on a later refresh".
	const captureTrackedCardPrs = async (entry: WorkspaceMetadataEntry): Promise<void> => {
		if (!deps.persistCardPr) {
			return;
		}
		const candidates = collectPrCandidates(entry);
		if (candidates.length === 0) {
			return;
		}
		const now = Date.now();
		for (const task of candidates) {
			if (task.hasStoredPrUrl) {
				entry.lastPrCheckedAtByTaskId.set(task.taskId, now);
			} else {
				entry.prResolveAttemptedAtByTaskId.set(task.taskId, now);
			}
		}

		const prsByHead = await resolveRepoCardPrs({ cwd: entry.workspacePath });
		if (prsByHead.size === 0) {
			return;
		}
		for (const task of candidates) {
			const pr = prsByHead.get(task.branchName);
			if (!pr) {
				continue;
			}
			await persistTrackedCardPr(entry, task, pr);
		}
	};

	const stopWorkspaceTimer = (entry: WorkspaceMetadataEntry) => {
		if (!entry.pollTimer) {
			return;
		}
		clearInterval(entry.pollTimer);
		entry.pollTimer = null;
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
	}): WorkspaceMetadataEntry => {
		const existing =
			workspaces.get(input.workspaceId) ?? createWorkspaceEntry(input.workspaceId, input.workspacePath);
		existing.workspacePath = input.workspacePath;
		existing.trackedTasks = collectTrackedTasks(input.board);
		workspaces.set(input.workspaceId, existing);
		return existing;
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

	return {
		connectWorkspace: async ({ workspaceId, workspacePath, board }) => {
			const entry = updateWorkspaceEntry({ workspaceId, workspacePath, board });
			entry.subscriberCount += 1;
			ensureWorkspaceTimer(workspaceId, entry);
			// Do NOT block the board's first render on a full git scan of every worktree plus
			// a sequential gh PR sweep — on a large board that can exceed the snapshot deadline
			// and leave the client looping on a blank loader. Return the cached snapshot now;
			// the refresh runs in the background and streams in via onMetadataUpdated
			// (and the poll timer keeps it fresh thereafter).
			void refreshWorkspace(workspaceId).catch(() => {});
			return buildWorkspaceMetadataSnapshot(entry);
		},
		updateWorkspaceState: async ({ workspaceId, workspacePath, board }) => {
			const entry = updateWorkspaceEntry({ workspaceId, workspacePath, board });
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
			workspaces.delete(workspaceId);
		},
		close: () => {
			for (const entry of workspaces.values()) {
				stopWorkspaceTimer(entry);
			}
			workspaces.clear();
		},
	};
}
