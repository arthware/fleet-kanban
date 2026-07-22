import { z } from "zod";
import { normalizeBoardTransitionsAndOrdering } from "./task-lifecycle";
import { resolveTaskTitle } from "./task-title.js";

export const runtimeWorkspaceFileStatusSchema = z.enum([
	"modified",
	"added",
	"deleted",
	"renamed",
	"copied",
	"untracked",
	"unknown",
]);
export type RuntimeWorkspaceFileStatus = z.infer<typeof runtimeWorkspaceFileStatusSchema>;

export const runtimeWorkspaceFileChangeSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: runtimeWorkspaceFileStatusSchema,
	additions: z.number(),
	deletions: z.number(),
	oldText: z.string().nullable(),
	newText: z.string().nullable(),
});
export type RuntimeWorkspaceFileChange = z.infer<typeof runtimeWorkspaceFileChangeSchema>;

export const runtimeWorkspaceChangesRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
	mode: z.enum(["working_copy", "last_turn"]).optional(),
});
export type RuntimeWorkspaceChangesRequest = z.infer<typeof runtimeWorkspaceChangesRequestSchema>;

export const runtimeWorkspaceChangesModeSchema = z.enum(["working_copy", "last_turn"]);
export type RuntimeWorkspaceChangesMode = z.infer<typeof runtimeWorkspaceChangesModeSchema>;

export const runtimeWorkspaceChangesResponseSchema = z.object({
	repoRoot: z.string(),
	generatedAt: z.number(),
	files: z.array(runtimeWorkspaceFileChangeSchema),
});
export type RuntimeWorkspaceChangesResponse = z.infer<typeof runtimeWorkspaceChangesResponseSchema>;

export const runtimeWorkspaceFileSearchRequestSchema = z.object({
	query: z.string(),
	limit: z.number().int().positive().optional(),
});
export type RuntimeWorkspaceFileSearchRequest = z.infer<typeof runtimeWorkspaceFileSearchRequestSchema>;

export const runtimeWorkspaceFileSearchMatchSchema = z.object({
	path: z.string(),
	name: z.string(),
	changed: z.boolean(),
});
export type RuntimeWorkspaceFileSearchMatch = z.infer<typeof runtimeWorkspaceFileSearchMatchSchema>;

export const runtimeWorkspaceFileSearchResponseSchema = z.object({
	query: z.string(),
	files: z.array(runtimeWorkspaceFileSearchMatchSchema),
});
export type RuntimeWorkspaceFileSearchResponse = z.infer<typeof runtimeWorkspaceFileSearchResponseSchema>;

export const runtimeDesignDocRequestSchema = z.object({
	taskId: z.string(),
	externalIssueKey: z.string().optional(),
});
export type RuntimeDesignDocRequest = z.infer<typeof runtimeDesignDocRequestSchema>;

export const runtimeDesignDocResponseSchema = z.object({
	exists: z.boolean(),
	path: z.string().optional(),
	content: z.string().optional(),
});
export type RuntimeDesignDocResponse = z.infer<typeof runtimeDesignDocResponseSchema>;

export const runtimeTaskFileRequestSchema = z.object({
	taskId: z.string(),
	path: z.string(),
});
export type RuntimeTaskFileRequest = z.infer<typeof runtimeTaskFileRequestSchema>;

export const runtimeTaskFileResponseSchema = z.object({
	exists: z.boolean(),
	path: z.string().optional(),
	content: z.string().optional(),
	tooLarge: z.boolean().optional(),
	binary: z.boolean().optional(),
	sizeBytes: z.number().int().nonnegative().optional(),
});
export type RuntimeTaskFileResponse = z.infer<typeof runtimeTaskFileResponseSchema>;

export const runtimeSlashCommandSchema = z.object({
	name: z.string(),
	instructions: z.string(),
	description: z.string().optional(),
});
export type RuntimeSlashCommand = z.infer<typeof runtimeSlashCommandSchema>;

export const runtimeSlashCommandsResponseSchema = z.object({
	commands: z.array(runtimeSlashCommandSchema),
});
export type RuntimeSlashCommandsResponse = z.infer<typeof runtimeSlashCommandsResponseSchema>;

export const runtimeAgentIdSchema = z.enum([
	"claude",
	"codex",
	"cursor",
	"gemini",
	"opencode",
	"droid",
	"kiro",
	"cline",
]);
export type RuntimeAgentId = z.infer<typeof runtimeAgentIdSchema>;

const runtimeBoardColumnIdEnum = z.enum(["backlog", "in_progress", "review", "done", "trash"]);
export const runtimeBoardColumnIdSchema = runtimeBoardColumnIdEnum;
export type RuntimeBoardColumnId = z.infer<typeof runtimeBoardColumnIdEnum>;

const runtimeTaskAutoReviewModeEnum = z.enum(["pr"]);
const runtimeLegacyTaskAutoReviewModeSchema = z
	.enum(["commit", "move_to_trash", "move_to_done"])
	.transform(() => undefined);
export const runtimeTaskAutoReviewModeSchema = z.union([
	runtimeTaskAutoReviewModeEnum,
	runtimeLegacyTaskAutoReviewModeSchema,
]);
export type RuntimeTaskAutoReviewMode = z.infer<typeof runtimeTaskAutoReviewModeEnum>;

export const runtimeClineReasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh"]);
export type RuntimeClineReasoningEffort = z.infer<typeof runtimeClineReasoningEffortSchema>;
export const runtimeTaskClineSettingsSchema = z.object({
	providerId: z.string().optional(),
	modelId: z.string().optional(),
	reasoningEffort: runtimeClineReasoningEffortSchema.optional(),
});
export type RuntimeTaskClineSettings = z.infer<typeof runtimeTaskClineSettingsSchema>;
export const runtimeTaskImageSchema = z.object({
	id: z.string(),
	data: z.string(),
	mimeType: z.string(),
	name: z.string().optional(),
});
export type RuntimeTaskImage = z.infer<typeof runtimeTaskImageSchema>;

const runtimeLegacyTaskClineReasoningEffortSchema = z.enum(["default", "low", "medium", "high", "xhigh"]);

function normalizeRuntimeTaskClineSettings(input: {
	clineSettings?: RuntimeTaskClineSettings;
	clineProviderId?: string;
	clineModelId?: string;
	clineReasoningEffort?: z.infer<typeof runtimeLegacyTaskClineReasoningEffortSchema>;
}): RuntimeTaskClineSettings | undefined {
	if (input.clineSettings !== undefined) {
		return input.clineSettings;
	}
	const providerId = input.clineProviderId?.trim();
	const modelId = input.clineModelId?.trim();
	if (!providerId && !modelId && input.clineReasoningEffort === undefined) {
		return undefined;
	}
	return {
		...(providerId ? { providerId } : {}),
		...(modelId ? { modelId } : {}),
		...(input.clineReasoningEffort && input.clineReasoningEffort !== "default"
			? { reasoningEffort: input.clineReasoningEffort }
			: {}),
	};
}

// The lifecycle state of the GitHub PR a card's branch led to. Mirrors the
// CardPrState union produced by PR lookup helpers in src/workspace/card-pr-url.
export const runtimeCardPrStateSchema = z.enum(["open", "merged", "closed"]);
export type RuntimeCardPrState = z.infer<typeof runtimeCardPrStateSchema>;

// A single external issue this card corresponds to (Linear or GitHub), for
// cross-linking the board to the source of record. Optional and informational.
export const runtimeExternalIssueProviderSchema = z.enum(["linear", "github"]);
export type RuntimeExternalIssueProvider = z.infer<typeof runtimeExternalIssueProviderSchema>;

export const runtimeExternalIssueSchema = z.object({
	provider: runtimeExternalIssueProviderSchema,
	key: z.string(),
	url: z.string().optional(),
	raw: z.string(),
});
export type RuntimeExternalIssue = z.infer<typeof runtimeExternalIssueSchema>;

export const runtimeBoardTransitionSchema = z.object({
	column: runtimeBoardColumnIdSchema,
	at: z.number(),
});
export type RuntimeBoardTransition = z.infer<typeof runtimeBoardTransitionSchema>;

export const runtimeBoardCardSchema = z
	.object({
		id: z.string(),
		title: z.string().optional(),
		prompt: z.string(),
		startInPlanMode: z.boolean(),
		autoReviewEnabled: z.boolean().optional(),
		autoReviewMode: runtimeTaskAutoReviewModeSchema.optional(),
		images: z.array(runtimeTaskImageSchema).optional(),
		agentId: runtimeAgentIdSchema.optional(),
		// Per-card model for the CLI-agent launch path (claude/codex/…). Distinct
		// from clineSettings (the Cline-SDK path). Passed to the agent CLI as its
		// native --model flag so mechanical cards can run a cheaper model. Optional
		// so a board.json written before this field existed still parses.
		agentModel: z.string().optional(),
		// Optional Agent Skills / SKILL.md pointer. The runtime injects only a
		// one-line instruction naming this skill; the agent loads the body natively
		// from .agents/skills/ in its task worktree.
		skill: z.string().optional(),
		// The GitHub PR a review/done card's branch led to. Captured once when the
		// PR is first detected (see workspace-metadata-monitor) and persisted onto
		// the card so the board can link to it without querying `gh` at render time
		// or on every poll. Optional so a board.json written before these fields
		// existed still parses.
		prUrl: z.string().optional(),
		prState: runtimeCardPrStateSchema.optional(),
		prNumber: z.number().int().optional(),
		externalIssue: runtimeExternalIssueSchema.optional(),
		transitions: z.array(runtimeBoardTransitionSchema).optional(),
		clineSettings: runtimeTaskClineSettingsSchema.optional(),
		clineProviderId: z.string().optional(),
		clineModelId: z.string().optional(),
		clineReasoningEffort: runtimeLegacyTaskClineReasoningEffortSchema.optional(),
		baseRef: z.string(),
		createdAt: z.number(),
		updatedAt: z.number(),
	})
	.transform(
		({
			clineProviderId: _legacyProviderId,
			clineModelId: _legacyModelId,
			clineReasoningEffort: _legacyReasoningEffort,
			autoReviewMode: rawAutoReviewMode,
			...card
		}) => {
			const clineSettings = normalizeRuntimeTaskClineSettings({
				clineSettings: card.clineSettings,
				clineProviderId: _legacyProviderId,
				clineModelId: _legacyModelId,
				clineReasoningEffort: _legacyReasoningEffort,
			});
			const autoReviewEnabled = card.autoReviewEnabled === true && rawAutoReviewMode === "pr";
			return {
				...card,
				autoReviewEnabled,
				...(autoReviewEnabled ? { autoReviewMode: rawAutoReviewMode } : {}),
				...(clineSettings !== undefined ? { clineSettings } : {}),
				title: resolveTaskTitle(card.title, card.prompt),
			};
		},
	);
export type RuntimeBoardCard = z.infer<typeof runtimeBoardCardSchema>;

export const runtimeBoardColumnSchema = z.object({
	id: runtimeBoardColumnIdSchema,
	title: z.string(),
	cards: z.array(runtimeBoardCardSchema),
});
export type RuntimeBoardColumn = z.infer<typeof runtimeBoardColumnSchema>;

export const runtimeBoardDependencySchema = z.object({
	id: z.string(),
	fromTaskId: z.string(),
	toTaskId: z.string(),
	createdAt: z.number(),
});
export type RuntimeBoardDependency = z.infer<typeof runtimeBoardDependencySchema>;

export const runtimeBoardDataSchema = z
	.object({
		columns: z.array(runtimeBoardColumnSchema),
		dependencies: z.array(runtimeBoardDependencySchema).default([]),
	})
	.transform((board) => {
		const hasDoneColumn = board.columns.some((column) => column.id === "done");
		const hasTrashColumn = board.columns.some((column) => column.id === "trash");
		if (hasDoneColumn || !hasTrashColumn) {
			return normalizeBoardTransitionsAndOrdering(board);
		}
		return normalizeBoardTransitionsAndOrdering({
			...board,
			columns: [
				...board.columns.map((column) => (column.id === "trash" ? { ...column, id: "done" as const } : column)),
				{ id: "trash" as const, title: "Trash", cards: [] },
			],
		});
	});
export type RuntimeBoardData = z.infer<typeof runtimeBoardDataSchema>;

export const runtimeArchivedCardsResponseSchema = z.object({
	board: z.object({
		columns: z.array(runtimeBoardColumnSchema),
		dependencies: z.array(runtimeBoardDependencySchema).default([]),
	}),
});
export type RuntimeArchivedCardsResponse = z.infer<typeof runtimeArchivedCardsResponseSchema>;

export const runtimeArchivedTaskRestoreRequestSchema = z.object({
	taskId: z.string(),
	targetColumnId: runtimeBoardColumnIdSchema.default("review"),
});
export type RuntimeArchivedTaskRestoreRequest = z.infer<typeof runtimeArchivedTaskRestoreRequestSchema>;

export const runtimeGitRepositoryInfoSchema = z.object({
	currentBranch: z.string().nullable(),
	defaultBranch: z.string().nullable(),
	branches: z.array(z.string()),
});
export type RuntimeGitRepositoryInfo = z.infer<typeof runtimeGitRepositoryInfoSchema>;

export const runtimeGitSyncActionSchema = z.enum(["fetch", "pull", "push"]);
export type RuntimeGitSyncAction = z.infer<typeof runtimeGitSyncActionSchema>;

export const runtimeGitSyncSummarySchema = z.object({
	currentBranch: z.string().nullable(),
	upstreamBranch: z.string().nullable(),
	changedFiles: z.number(),
	additions: z.number(),
	deletions: z.number(),
	aheadCount: z.number(),
	behindCount: z.number(),
});
export type RuntimeGitSyncSummary = z.infer<typeof runtimeGitSyncSummarySchema>;

export const runtimeGitSummaryResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	error: z.string().optional(),
});
export type RuntimeGitSummaryResponse = z.infer<typeof runtimeGitSummaryResponseSchema>;

export const runtimeGitSyncResponseSchema = z.object({
	ok: z.boolean(),
	action: runtimeGitSyncActionSchema,
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitSyncResponse = z.infer<typeof runtimeGitSyncResponseSchema>;

export const runtimeGitCheckoutRequestSchema = z.object({
	branch: z.string(),
});
export type RuntimeGitCheckoutRequest = z.infer<typeof runtimeGitCheckoutRequestSchema>;

export const runtimeGitCheckoutResponseSchema = z.object({
	ok: z.boolean(),
	branch: z.string(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitCheckoutResponse = z.infer<typeof runtimeGitCheckoutResponseSchema>;

export const runtimeGitDiscardResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeGitSyncSummarySchema,
	output: z.string(),
	error: z.string().optional(),
});
export type RuntimeGitDiscardResponse = z.infer<typeof runtimeGitDiscardResponseSchema>;

export const runtimeTaskSessionStateSchema = z.enum(["idle", "running", "awaiting_review", "failed", "interrupted"]);
export type RuntimeTaskSessionState = z.infer<typeof runtimeTaskSessionStateSchema>;

export const runtimeTaskSessionModeSchema = z.enum(["act", "plan"]);
export type RuntimeTaskSessionMode = z.infer<typeof runtimeTaskSessionModeSchema>;

export const runtimeTaskSessionReviewReasonSchema = z
	.enum(["attention", "exit", "error", "interrupted", "hook", "needs_input"])
	.nullable();
export type RuntimeTaskSessionReviewReason = z.infer<typeof runtimeTaskSessionReviewReasonSchema>;

export const runtimeAgentSessionLifecycleSchema = z.enum(["attached", "resumable", "gone"]);
export type RuntimeAgentSessionLifecycle = z.infer<typeof runtimeAgentSessionLifecycleSchema>;

export const runtimeTaskHookActivitySchema = z.object({
	activityText: z.string().nullable().default(null),
	toolName: z.string().nullable().default(null),
	toolInputSummary: z.string().nullable().default(null),
	finalMessage: z.string().nullable().default(null),
	hookEventName: z.string().nullable().default(null),
	notificationType: z.string().nullable().default(null),
	source: z.string().nullable().default(null),
});
export type RuntimeTaskHookActivity = z.infer<typeof runtimeTaskHookActivitySchema>;

export const runtimeTaskTurnCheckpointSchema = z.object({
	turn: z.number().int().positive(),
	ref: z.string(),
	commit: z.string(),
	createdAt: z.number(),
});
export type RuntimeTaskTurnCheckpoint = z.infer<typeof runtimeTaskTurnCheckpointSchema>;

export const runtimeTaskSessionSummarySchema = z.object({
	taskId: z.string(),
	state: runtimeTaskSessionStateSchema,
	mode: runtimeTaskSessionModeSchema.nullable().optional(),
	agentId: runtimeAgentIdSchema.nullable(),
	workspacePath: z.string().nullable(),
	pid: z.number().nullable(),
	startedAt: z.number().nullable(),
	updatedAt: z.number(),
	lastOutputAt: z.number().nullable(),
	reviewReason: runtimeTaskSessionReviewReasonSchema,
	exitCode: z.number().nullable(),
	// The agent CLI's own session/conversation id, captured on start so a later
	// board load can resume the exact same session by id. Defaults to null so a
	// sessions.json written before this field existed still parses.
	agentSessionId: z.string().nullable().default(null),
	agentSessionLifecycle: runtimeAgentSessionLifecycleSchema.optional(),
	lastHookAt: z.number().nullable().default(null),
	latestHookActivity: runtimeTaskHookActivitySchema.nullable().default(null),
	warningMessage: z.string().nullable().optional(),
	latestTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
	previousTurnCheckpoint: runtimeTaskTurnCheckpointSchema.nullable().optional(),
});
export type RuntimeTaskSessionSummary = z.infer<typeof runtimeTaskSessionSummarySchema>;

export const runtimeWorkspaceStateResponseSchema = z.object({
	repoPath: z.string(),
	statePath: z.string(),
	// Absolute root under which this instance's task worktrees live. Follows
	// CLINE_HOME, so the client can display real worktree paths instead of
	// reconstructing a hardcoded ~/.cline/worktrees.
	taskWorktreesRoot: z.string(),
	git: runtimeGitRepositoryInfoSchema,
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	revision: z.number(),
});
export type RuntimeWorkspaceStateResponse = z.infer<typeof runtimeWorkspaceStateResponseSchema>;

export const runtimeWorkspaceStateSaveRequestSchema = z.object({
	board: runtimeBoardDataSchema,
	sessions: z.record(z.string(), runtimeTaskSessionSummarySchema),
	expectedRevision: z.number().int().nonnegative().optional(),
});
export type RuntimeWorkspaceStateSaveRequest = z.infer<typeof runtimeWorkspaceStateSaveRequestSchema>;

export const runtimeWorkspaceStateConflictResponseSchema = z.object({
	error: z.string(),
	currentRevision: z.number(),
});
export type RuntimeWorkspaceStateConflictResponse = z.infer<typeof runtimeWorkspaceStateConflictResponseSchema>;

export const runtimeWorkspaceStateNotifyResponseSchema = z.object({
	ok: z.boolean(),
});
export type RuntimeWorkspaceStateNotifyResponse = z.infer<typeof runtimeWorkspaceStateNotifyResponseSchema>;

export const runtimeProjectTaskCountsSchema = z.object({
	backlog: z.number(),
	in_progress: z.number(),
	review: z.number(),
	done: z.number(),
	trash: z.number(),
});
export type RuntimeProjectTaskCounts = z.infer<typeof runtimeProjectTaskCountsSchema>;

export const runtimeProjectSummarySchema = z.object({
	id: z.string(),
	path: z.string(),
	name: z.string(),
	taskCounts: runtimeProjectTaskCountsSchema,
});
export type RuntimeProjectSummary = z.infer<typeof runtimeProjectSummarySchema>;

export const runtimeTaskWorkspaceMetadataSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	branch: z.string().nullable(),
	isDetached: z.boolean(),
	headCommit: z.string().nullable(),
	changedFiles: z.number().nullable(),
	additions: z.number().nullable(),
	deletions: z.number().nullable(),
	stateVersion: z.number().int().nonnegative(),
});
export type RuntimeTaskWorkspaceMetadata = z.infer<typeof runtimeTaskWorkspaceMetadataSchema>;

export const runtimeWorkspaceMetadataSchema = z.object({
	homeGitSummary: runtimeGitSyncSummarySchema.nullable(),
	homeGitStateVersion: z.number().int().nonnegative(),
	taskWorkspaces: z.array(runtimeTaskWorkspaceMetadataSchema),
});
export type RuntimeWorkspaceMetadata = z.infer<typeof runtimeWorkspaceMetadataSchema>;

export const runtimeClineMcpServerAuthStatusSchema = z.object({
	serverName: z.string(),
	oauthSupported: z.boolean(),
	oauthConfigured: z.boolean(),
	lastError: z.string().nullable(),
	lastAuthenticatedAt: z.number().nullable(),
});
export type RuntimeClineMcpServerAuthStatus = z.infer<typeof runtimeClineMcpServerAuthStatusSchema>;

export const runtimeStateStreamSnapshotMessageSchema = z.object({
	type: z.literal("snapshot"),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
	/** The pinned overseer workspace (excluded from `projects`), or `null` for a flat board. */
	architectWorkspaceId: z.string().nullable(),
	workspaceState: runtimeWorkspaceStateResponseSchema.nullable(),
	workspaceMetadata: runtimeWorkspaceMetadataSchema.nullable(),
	clineSessionContextVersion: z.number().int().nonnegative(),
});
export type RuntimeStateStreamSnapshotMessage = z.infer<typeof runtimeStateStreamSnapshotMessageSchema>;

export const runtimeStateStreamWorkspaceStateMessageSchema = z.object({
	type: z.literal("workspace_state_updated"),
	workspaceId: z.string(),
	workspaceState: runtimeWorkspaceStateResponseSchema,
});
export type RuntimeStateStreamWorkspaceStateMessage = z.infer<typeof runtimeStateStreamWorkspaceStateMessageSchema>;

export const runtimeStateStreamTaskSessionsMessageSchema = z.object({
	type: z.literal("task_sessions_updated"),
	workspaceId: z.string(),
	summaries: z.array(runtimeTaskSessionSummarySchema),
});
export type RuntimeStateStreamTaskSessionsMessage = z.infer<typeof runtimeStateStreamTaskSessionsMessageSchema>;

export const runtimeStateStreamProjectsMessageSchema = z.object({
	type: z.literal("projects_updated"),
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
	/** The pinned overseer workspace (excluded from `projects`), or `null` for a flat board. */
	architectWorkspaceId: z.string().nullable(),
});
export type RuntimeStateStreamProjectsMessage = z.infer<typeof runtimeStateStreamProjectsMessageSchema>;

export const runtimeStateStreamWorkspaceMetadataMessageSchema = z.object({
	type: z.literal("workspace_metadata_updated"),
	workspaceId: z.string(),
	workspaceMetadata: runtimeWorkspaceMetadataSchema,
});
export type RuntimeStateStreamWorkspaceMetadataMessage = z.infer<
	typeof runtimeStateStreamWorkspaceMetadataMessageSchema
>;

export const runtimeStateStreamTaskReadyForReviewMessageSchema = z.object({
	type: z.literal("task_ready_for_review"),
	workspaceId: z.string(),
	taskId: z.string(),
	triggeredAt: z.number(),
});
export type RuntimeStateStreamTaskReadyForReviewMessage = z.infer<
	typeof runtimeStateStreamTaskReadyForReviewMessageSchema
>;

export const runtimeStateStreamTaskChatMessageSchema = z.object({
	type: z.literal("task_chat_message"),
	workspaceId: z.string(),
	taskId: z.string(),
	message: z.lazy(() => runtimeTaskChatMessageSchema),
});
export type RuntimeStateStreamTaskChatMessage = z.infer<typeof runtimeStateStreamTaskChatMessageSchema>;

export const runtimeStateStreamTaskChatClearedMessageSchema = z.object({
	type: z.literal("task_chat_cleared"),
	workspaceId: z.string(),
	taskId: z.string(),
});
export type RuntimeStateStreamTaskChatClearedMessage = z.infer<typeof runtimeStateStreamTaskChatClearedMessageSchema>;

export const runtimeStateStreamMcpAuthUpdatedMessageSchema = z.object({
	type: z.literal("mcp_auth_updated"),
	statuses: z.array(runtimeClineMcpServerAuthStatusSchema),
});
export type RuntimeStateStreamMcpAuthUpdatedMessage = z.infer<typeof runtimeStateStreamMcpAuthUpdatedMessageSchema>;

export const runtimeStateStreamClineSessionContextUpdatedMessageSchema = z.object({
	type: z.literal("cline_session_context_updated"),
	version: z.number().int().nonnegative(),
});
export type RuntimeStateStreamClineSessionContextUpdatedMessage = z.infer<
	typeof runtimeStateStreamClineSessionContextUpdatedMessageSchema
>;

export const runtimeStateStreamErrorMessageSchema = z.object({
	type: z.literal("error"),
	message: z.string(),
});
export type RuntimeStateStreamErrorMessage = z.infer<typeof runtimeStateStreamErrorMessageSchema>;

export const runtimeStateStreamMessageSchema = z.discriminatedUnion("type", [
	runtimeStateStreamSnapshotMessageSchema,
	runtimeStateStreamWorkspaceStateMessageSchema,
	runtimeStateStreamTaskSessionsMessageSchema,
	runtimeStateStreamProjectsMessageSchema,
	runtimeStateStreamWorkspaceMetadataMessageSchema,
	runtimeStateStreamTaskReadyForReviewMessageSchema,
	runtimeStateStreamTaskChatMessageSchema,
	runtimeStateStreamTaskChatClearedMessageSchema,
	runtimeStateStreamMcpAuthUpdatedMessageSchema,
	runtimeStateStreamClineSessionContextUpdatedMessageSchema,
	runtimeStateStreamErrorMessageSchema,
]);
export type RuntimeStateStreamMessage = z.infer<typeof runtimeStateStreamMessageSchema>;

export const runtimeProjectsResponseSchema = z.object({
	currentProjectId: z.string().nullable(),
	projects: z.array(runtimeProjectSummarySchema),
	/** The pinned overseer workspace (excluded from `projects`), or `null` for a flat board. */
	architectWorkspaceId: z.string().nullable(),
});
export type RuntimeProjectsResponse = z.infer<typeof runtimeProjectsResponseSchema>;

export const runtimeProjectAddRequestSchema = z
	.object({
		path: z.string().optional(),
		gitUrl: z.string().optional(),
		initializeGit: z.boolean().optional(),
	})
	.refine((data) => data.path || data.gitUrl, { message: "Either path or gitUrl is required" });
export type RuntimeProjectAddRequest = z.infer<typeof runtimeProjectAddRequestSchema>;

export const runtimeProjectAddResponseSchema = z.object({
	ok: z.boolean(),
	project: runtimeProjectSummarySchema.nullable(),
	requiresGitInitialization: z.boolean().optional(),
	error: z.string().optional(),
});
export type RuntimeProjectAddResponse = z.infer<typeof runtimeProjectAddResponseSchema>;

export const runtimeProjectDirectoryPickerResponseSchema = z.object({
	ok: z.boolean(),
	path: z.string().nullable(),
	error: z.string().optional(),
});
export type RuntimeProjectDirectoryPickerResponse = z.infer<typeof runtimeProjectDirectoryPickerResponseSchema>;

export const runtimeDirectoryListEntrySchema = z.object({
	name: z.string(),
	path: z.string(),
	isGitRepository: z.boolean(),
});
export type RuntimeDirectoryListEntry = z.infer<typeof runtimeDirectoryListEntrySchema>;

export const runtimeDirectoryListRequestSchema = z.object({
	path: z.string().optional(),
});
export type RuntimeDirectoryListRequest = z.infer<typeof runtimeDirectoryListRequestSchema>;

export const runtimeDirectoryListResponseSchema = z.object({
	ok: z.boolean(),
	currentPath: z.string(),
	parentPath: z.string().nullable(),
	rootPath: z.string(),
	entries: z.array(runtimeDirectoryListEntrySchema),
	error: z.string().optional(),
});
export type RuntimeDirectoryListResponse = z.infer<typeof runtimeDirectoryListResponseSchema>;

export const runtimeProjectRemoveRequestSchema = z.object({
	projectId: z.string(),
});
export type RuntimeProjectRemoveRequest = z.infer<typeof runtimeProjectRemoveRequestSchema>;

export const runtimeProjectRemoveResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeProjectRemoveResponse = z.infer<typeof runtimeProjectRemoveResponseSchema>;

export const runtimeWorktreeEnsureRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
});
export type RuntimeWorktreeEnsureRequest = z.infer<typeof runtimeWorktreeEnsureRequestSchema>;

export const runtimeWorktreeEnsureResponseSchema = z.union([
	z.object({
		ok: z.literal(true),
		path: z.string(),
		baseRef: z.string(),
		baseCommit: z.string(),
		warning: z.string().optional(),
		error: z.string().optional(),
	}),
	z.object({
		ok: z.literal(false),
		path: z.null(),
		baseRef: z.string(),
		baseCommit: z.null(),
		error: z.string().optional(),
	}),
]);
export type RuntimeWorktreeEnsureResponse = z.infer<typeof runtimeWorktreeEnsureResponseSchema>;

// "Is this card's work durably saved?" — the assessment that gates a card
// becoming Done and its worktree being removed. Mirrors the TaskWorkDurability*
// types in src/workspace/durable-save.ts, which owns the classification logic.
export const runtimeTaskWorkDurabilityStatusSchema = z.enum([
	"no_worktree",
	"clean_and_landed",
	"merged",
	"uncommitted_changes",
	"unlanded_commits",
	"awaiting_merge",
	"indeterminate",
]);
export type RuntimeTaskWorkDurabilityStatus = z.infer<typeof runtimeTaskWorkDurabilityStatusSchema>;

export const runtimeTaskWorkDurabilityAssessmentSchema = z.object({
	durable: z.boolean(),
	status: runtimeTaskWorkDurabilityStatusSchema,
	detail: z.string(),
});
export type RuntimeTaskWorkDurabilityAssessment = z.infer<typeof runtimeTaskWorkDurabilityAssessmentSchema>;

export const runtimeWorktreeDeleteRequestSchema = z.object({
	taskId: z.string(),
	// Explicit Discard: remove the worktree even when its work is not durably
	// saved. Absent/false means the durability gate is enforced.
	discard: z.boolean().optional(),
});
export type RuntimeWorktreeDeleteRequest = z.infer<typeof runtimeWorktreeDeleteRequestSchema>;

export const runtimeWorktreeDeleteResponseSchema = z.object({
	ok: z.boolean(),
	removed: z.boolean(),
	// True when the delete was refused because the work is not durably saved and
	// the caller did not explicitly Discard. The worktree is retained.
	blocked: z.boolean().optional(),
	durability: runtimeTaskWorkDurabilityAssessmentSchema.optional(),
	error: z.string().optional(),
});
export type RuntimeWorktreeDeleteResponse = z.infer<typeof runtimeWorktreeDeleteResponseSchema>;

export const runtimeTaskDurabilityRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskDurabilityRequest = z.infer<typeof runtimeTaskDurabilityRequestSchema>;

export const runtimeTaskDurabilityResponseSchema = z.object({
	ok: z.literal(true),
	taskId: z.string(),
	durability: runtimeTaskWorkDurabilityAssessmentSchema,
});
export type RuntimeTaskDurabilityResponse = z.infer<typeof runtimeTaskDurabilityResponseSchema>;

export const runtimeTaskWorkspaceInfoRequestSchema = z.object({
	taskId: z.string(),
	baseRef: z.string(),
});
export type RuntimeTaskWorkspaceInfoRequest = z.infer<typeof runtimeTaskWorkspaceInfoRequestSchema>;

export const runtimeTaskWorkspaceInfoResponseSchema = z.object({
	taskId: z.string(),
	path: z.string(),
	exists: z.boolean(),
	baseRef: z.string(),
	branch: z.string().nullable(),
	isDetached: z.boolean(),
	headCommit: z.string().nullable(),
});
export type RuntimeTaskWorkspaceInfoResponse = z.infer<typeof runtimeTaskWorkspaceInfoResponseSchema>;

export const runtimeProjectShortcutSchema = z.object({
	label: z.string(),
	command: z.string(),
	icon: z.string().optional(),
});
export type RuntimeProjectShortcut = z.infer<typeof runtimeProjectShortcutSchema>;

export const runtimeClineOauthProviderSchema = z.enum(["cline", "oca", "openai-codex"]);
export type RuntimeClineOauthProvider = z.infer<typeof runtimeClineOauthProviderSchema>;

export const runtimeClineProviderSettingsSchema = z.object({
	providerId: z.string().nullable(),
	modelId: z.string().nullable(),
	baseUrl: z.string().nullable(),
	reasoningEffort: runtimeClineReasoningEffortSchema.nullable().optional(),
	apiKeyConfigured: z.boolean(),
	oauthProvider: runtimeClineOauthProviderSchema.nullable(),
	oauthAccessTokenConfigured: z.boolean(),
	oauthRefreshTokenConfigured: z.boolean(),
	oauthAccountId: z.string().nullable(),
	oauthExpiresAt: z.number().int().positive().nullable(),
});
export type RuntimeClineProviderSettings = z.infer<typeof runtimeClineProviderSettingsSchema>;

export const runtimeClineAccountProfileSchema = z.object({
	accountId: z.string().nullable(),
	email: z.string().nullable(),
	displayName: z.string().nullable(),
});
export type RuntimeClineAccountProfile = z.infer<typeof runtimeClineAccountProfileSchema>;

export const runtimeClineAccountProfileResponseSchema = z.object({
	profile: runtimeClineAccountProfileSchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeClineAccountProfileResponse = z.infer<typeof runtimeClineAccountProfileResponseSchema>;

export const runtimeClineKanbanAccessResponseSchema = z.object({
	enabled: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeClineKanbanAccessResponse = z.infer<typeof runtimeClineKanbanAccessResponseSchema>;

export const runtimeClineAccountOrganizationSchema = z.object({
	organizationId: z.string(),
	name: z.string(),
	active: z.boolean(),
	roles: z.array(z.string()),
});
export type RuntimeClineAccountOrganization = z.infer<typeof runtimeClineAccountOrganizationSchema>;

export const runtimeClineAccountOrganizationsResponseSchema = z.object({
	organizations: z.array(runtimeClineAccountOrganizationSchema),
	error: z.string().optional(),
});
export type RuntimeClineAccountOrganizationsResponse = z.infer<typeof runtimeClineAccountOrganizationsResponseSchema>;

export const runtimeClineAccountBalanceResponseSchema = z.object({
	balance: z.number().nullable(),
	activeAccountLabel: z.string().nullable(),
	activeOrganizationId: z.string().nullable(),
	error: z.string().optional(),
});
export type RuntimeClineAccountBalanceResponse = z.infer<typeof runtimeClineAccountBalanceResponseSchema>;

export const runtimeClineAccountSwitchRequestSchema = z.object({
	organizationId: z.string().nullable(),
});
export type RuntimeClineAccountSwitchRequest = z.infer<typeof runtimeClineAccountSwitchRequestSchema>;

export const runtimeClineAccountSwitchResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeClineAccountSwitchResponse = z.infer<typeof runtimeClineAccountSwitchResponseSchema>;

export const runtimeFeaturebaseTokenResponseSchema = z.object({
	featurebaseJwt: z.string(),
});
export type RuntimeFeaturebaseTokenResponse = z.infer<typeof runtimeFeaturebaseTokenResponseSchema>;

export const runtimeClineProviderCatalogItemSchema = z.object({
	id: z.string(),
	name: z.string(),
	oauthSupported: z.boolean(),
	enabled: z.boolean(),
	defaultModelId: z.string().nullable(),
	baseUrl: z.string().nullable(),
	supportsBaseUrl: z.boolean(),
	env: z.array(z.string()).optional(),
});
export type RuntimeClineProviderCatalogItem = z.infer<typeof runtimeClineProviderCatalogItemSchema>;

export const runtimeClineProviderCatalogResponseSchema = z.object({
	providers: z.array(runtimeClineProviderCatalogItemSchema),
});
export type RuntimeClineProviderCatalogResponse = z.infer<typeof runtimeClineProviderCatalogResponseSchema>;

export const runtimeClineProviderModelsRequestSchema = z.object({
	providerId: z.string(),
});
export type RuntimeClineProviderModelsRequest = z.infer<typeof runtimeClineProviderModelsRequestSchema>;

export const runtimeClineProviderModelSchema = z.object({
	id: z.string(),
	name: z.string(),
	supportsVision: z.boolean().optional(),
	supportsAttachments: z.boolean().optional(),
	supportsReasoningEffort: z.boolean().optional(),
});
export type RuntimeClineProviderModel = z.infer<typeof runtimeClineProviderModelSchema>;

export const runtimeClineProviderModelsResponseSchema = z.object({
	providerId: z.string(),
	models: z.array(runtimeClineProviderModelSchema),
});
export type RuntimeClineProviderModelsResponse = z.infer<typeof runtimeClineProviderModelsResponseSchema>;

export const runtimeClineProviderCapabilitySchema = z.enum([
	"streaming",
	"tools",
	"reasoning",
	"vision",
	"prompt-cache",
]);
export type RuntimeClineProviderCapability = z.infer<typeof runtimeClineProviderCapabilitySchema>;

export const runtimeClineAddProviderRequestSchema = z.object({
	providerId: z.string(),
	name: z.string(),
	baseUrl: z.string(),
	apiKey: z.string().nullable().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	timeoutMs: z.number().int().positive().optional(),
	models: z.array(z.string()),
	defaultModelId: z.string().nullable().optional(),
	modelsSourceUrl: z.string().nullable().optional(),
	capabilities: z.array(runtimeClineProviderCapabilitySchema).optional(),
});
export type RuntimeClineAddProviderRequest = z.infer<typeof runtimeClineAddProviderRequestSchema>;

export const runtimeClineAddProviderResponseSchema = runtimeClineProviderSettingsSchema;
export type RuntimeClineAddProviderResponse = z.infer<typeof runtimeClineAddProviderResponseSchema>;

export const runtimeClineUpdateProviderRequestSchema = z.object({
	providerId: z.string(),
	name: z.string().optional(),
	baseUrl: z.string().optional(),
	apiKey: z.string().nullable().optional(),
	headers: z.record(z.string(), z.string()).nullable().optional(),
	timeoutMs: z.number().int().positive().nullable().optional(),
	models: z.array(z.string()).optional(),
	defaultModelId: z.string().nullable().optional(),
	modelsSourceUrl: z.string().nullable().optional(),
	capabilities: z.array(runtimeClineProviderCapabilitySchema).optional(),
});
export type RuntimeClineUpdateProviderRequest = z.infer<typeof runtimeClineUpdateProviderRequestSchema>;

export const runtimeClineUpdateProviderResponseSchema = runtimeClineProviderSettingsSchema;
export type RuntimeClineUpdateProviderResponse = z.infer<typeof runtimeClineUpdateProviderResponseSchema>;

export const runtimeClineOauthLoginRequestSchema = z.object({
	provider: runtimeClineOauthProviderSchema,
	baseUrl: z.string().nullable().optional(),
});
export type RuntimeClineOauthLoginRequest = z.infer<typeof runtimeClineOauthLoginRequestSchema>;

export const runtimeClineOauthLoginResponseSchema = z.object({
	ok: z.boolean(),
	provider: runtimeClineOauthProviderSchema,
	settings: runtimeClineProviderSettingsSchema.optional(),
	error: z.string().optional(),
});
export type RuntimeClineOauthLoginResponse = z.infer<typeof runtimeClineOauthLoginResponseSchema>;

export const runtimeClineDeviceAuthStartResponseSchema = z.object({
	deviceCode: z.string(),
	userCode: z.string(),
	verificationUrl: z.string(),
	expiresInSeconds: z.number(),
	pollIntervalSeconds: z.number(),
});
export type RuntimeClineDeviceAuthStartResponse = z.infer<typeof runtimeClineDeviceAuthStartResponseSchema>;

export const runtimeClineDeviceAuthCompleteRequestSchema = z.object({
	deviceCode: z.string(),
	expiresInSeconds: z.number(),
	pollIntervalSeconds: z.number(),
	baseUrl: z.string().nullable().optional(),
});
export type RuntimeClineDeviceAuthCompleteRequest = z.infer<typeof runtimeClineDeviceAuthCompleteRequestSchema>;

export const runtimeClineDeviceAuthCompleteResponseSchema = runtimeClineOauthLoginResponseSchema;
export type RuntimeClineDeviceAuthCompleteResponse = z.infer<typeof runtimeClineDeviceAuthCompleteResponseSchema>;

export const runtimeClineProviderSettingsSaveRequestSchema = z.object({
	providerId: z.string(),
	modelId: z.string().nullable().optional(),
	apiKey: z.string().nullable().optional(),
	baseUrl: z.string().nullable().optional(),
	reasoningEffort: runtimeClineReasoningEffortSchema.nullable().optional(),
	region: z.string().nullable().optional(),
	aws: z
		.object({
			accessKey: z.string().nullable().optional(),
			secretKey: z.string().nullable().optional(),
			sessionToken: z.string().nullable().optional(),
			region: z.string().nullable().optional(),
			profile: z.string().nullable().optional(),
			authentication: z.enum(["iam", "api-key", "profile"]).nullable().optional(),
			endpoint: z.string().nullable().optional(),
		})
		.optional(),
	gcp: z
		.object({
			projectId: z.string().nullable().optional(),
			region: z.string().nullable().optional(),
		})
		.optional(),
});
export type RuntimeClineProviderSettingsSaveRequest = z.infer<typeof runtimeClineProviderSettingsSaveRequestSchema>;

export const runtimeClineProviderSettingsSaveResponseSchema = runtimeClineProviderSettingsSchema;
export type RuntimeClineProviderSettingsSaveResponse = z.infer<typeof runtimeClineProviderSettingsSaveResponseSchema>;

const runtimeClineMcpServerBaseSchema = z.object({
	name: z.string(),
	disabled: z.boolean(),
});

export const runtimeClineMcpServerSchema = z.discriminatedUnion("type", [
	runtimeClineMcpServerBaseSchema.extend({
		type: z.literal("stdio"),
		command: z.string(),
		args: z.array(z.string()).optional(),
		cwd: z.string().optional(),
		env: z.record(z.string(), z.string()).optional(),
	}),
	runtimeClineMcpServerBaseSchema.extend({
		type: z.literal("sse"),
		url: z.string().url(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
	runtimeClineMcpServerBaseSchema.extend({
		type: z.literal("streamableHttp"),
		url: z.string().url(),
		headers: z.record(z.string(), z.string()).optional(),
	}),
]);
export type RuntimeClineMcpServer = z.infer<typeof runtimeClineMcpServerSchema>;

export const runtimeClineMcpSettingsResponseSchema = z.object({
	path: z.string(),
	servers: z.array(runtimeClineMcpServerSchema),
});
export type RuntimeClineMcpSettingsResponse = z.infer<typeof runtimeClineMcpSettingsResponseSchema>;

export const runtimeClineMcpSettingsSaveRequestSchema = z.object({
	servers: z.array(runtimeClineMcpServerSchema),
});
export type RuntimeClineMcpSettingsSaveRequest = z.infer<typeof runtimeClineMcpSettingsSaveRequestSchema>;

export const runtimeClineMcpSettingsSaveResponseSchema = runtimeClineMcpSettingsResponseSchema;
export type RuntimeClineMcpSettingsSaveResponse = z.infer<typeof runtimeClineMcpSettingsSaveResponseSchema>;

export const runtimeClineMcpAuthStatusResponseSchema = z.object({
	statuses: z.array(runtimeClineMcpServerAuthStatusSchema),
});
export type RuntimeClineMcpAuthStatusResponse = z.infer<typeof runtimeClineMcpAuthStatusResponseSchema>;

export const runtimeClineMcpOAuthRequestSchema = z.object({
	serverName: z.string(),
});
export type RuntimeClineMcpOAuthRequest = z.infer<typeof runtimeClineMcpOAuthRequestSchema>;

export const runtimeClineMcpOAuthResponseSchema = z.object({
	serverName: z.string(),
	authorized: z.literal(true),
	message: z.string(),
});
export type RuntimeClineMcpOAuthResponse = z.infer<typeof runtimeClineMcpOAuthResponseSchema>;

export const runtimeCommandRunRequestSchema = z.object({
	command: z.string(),
});
export type RuntimeCommandRunRequest = z.infer<typeof runtimeCommandRunRequestSchema>;

export const runtimeCommandRunResponseSchema = z.object({
	exitCode: z.number(),
	stdout: z.string(),
	stderr: z.string(),
	combinedOutput: z.string(),
	durationMs: z.number(),
});
export type RuntimeCommandRunResponse = z.infer<typeof runtimeCommandRunResponseSchema>;

export const runtimeOpenFileRequestSchema = z.object({
	filePath: z.string(),
});
export type RuntimeOpenFileRequest = z.infer<typeof runtimeOpenFileRequestSchema>;

export const runtimeOpenFileResponseSchema = z.object({
	ok: z.boolean(),
});
export type RuntimeOpenFileResponse = z.infer<typeof runtimeOpenFileResponseSchema>;

export const runtimeDebugResetAllStateResponseSchema = z.object({
	ok: z.boolean(),
	clearedPaths: z.array(z.string()),
});
export type RuntimeDebugResetAllStateResponse = z.infer<typeof runtimeDebugResetAllStateResponseSchema>;

export const runtimeUpdateStatusResponseSchema = z.object({
	currentVersion: z.string(),
	latestVersion: z.string().nullable(),
	updateAvailable: z.boolean(),
	updateTiming: z.enum(["startup", "shutdown"]).nullable(),
	installCommand: z.string().nullable(),
});
export type RuntimeUpdateStatusResponse = z.infer<typeof runtimeUpdateStatusResponseSchema>;

export const runtimeRunUpdateResponseSchema = z.object({
	status: z.enum([
		"updated",
		"already_up_to_date",
		"cache_refreshed",
		"unsupported_installation",
		"check_failed",
		"update_failed",
	]),
	currentVersion: z.string(),
	latestVersion: z.string().nullable(),
	message: z.string(),
});
export type RuntimeRunUpdateResponse = z.infer<typeof runtimeRunUpdateResponseSchema>;

export const runtimeAgentDefinitionSchema = z.object({
	id: runtimeAgentIdSchema,
	label: z.string(),
	binary: z.string(),
	command: z.string(),
	defaultArgs: z.array(z.string()),
	installed: z.boolean(),
	configured: z.boolean(),
});
export type RuntimeAgentDefinition = z.infer<typeof runtimeAgentDefinitionSchema>;

export const runtimeWorktreePostCreateFailureModeSchema = z.enum(["warn", "block"]);
export type RuntimeWorktreePostCreateFailureMode = z.infer<typeof runtimeWorktreePostCreateFailureModeSchema>;

export const runtimeWorktreeConfigSchema = z.object({
	postCreateCommand: z.union([z.string(), z.array(z.string())]).optional(),
	postCreateTimeoutMs: z.number().int().positive().optional(),
	postCreateFailureMode: runtimeWorktreePostCreateFailureModeSchema.optional(),
});
export type RuntimeWorktreeConfig = z.infer<typeof runtimeWorktreeConfigSchema>;

export const runtimeConfigResponseSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema,
	selectedShortcutLabel: z.string().nullable(),
	agentAutonomousModeEnabled: z.boolean(),
	debugModeEnabled: z.boolean().optional(),
	effectiveCommand: z.string().nullable(),
	globalConfigPath: z.string(),
	projectConfigPath: z.string().nullable(),
	readyForReviewNotificationsEnabled: z.boolean(),
	detectedCommands: z.array(z.string()),
	agents: z.array(runtimeAgentDefinitionSchema),
	shortcuts: z.array(runtimeProjectShortcutSchema),
	worktree: runtimeWorktreeConfigSchema,
	clineProviderSettings: runtimeClineProviderSettingsSchema,
});
export type RuntimeConfigResponse = z.infer<typeof runtimeConfigResponseSchema>;

export const runtimeConfigSaveRequestSchema = z.object({
	selectedAgentId: runtimeAgentIdSchema.optional(),
	selectedShortcutLabel: z.string().nullable().optional(),
	agentAutonomousModeEnabled: z.boolean().optional(),
	shortcuts: z.array(runtimeProjectShortcutSchema).optional(),
	worktree: runtimeWorktreeConfigSchema.optional(),
	readyForReviewNotificationsEnabled: z.boolean().optional(),
});
export type RuntimeConfigSaveRequest = z.infer<typeof runtimeConfigSaveRequestSchema>;

export const runtimeTaskSessionStartRequestSchema = z.object({
	taskId: z.string(),
	prompt: z.string(),
	/** Display title from the Kanban task card. Propagated to SDK session metadata as a convenience copy. */
	taskTitle: z.string().optional(),
	images: z.array(runtimeTaskImageSchema).optional(),
	startInPlanMode: z.boolean().optional(),
	autoReviewEnabled: z.boolean().optional(),
	autoReviewMode: runtimeTaskAutoReviewModeSchema.optional(),
	mode: runtimeTaskSessionModeSchema.optional(),
	resumeFromTrash: z.boolean().optional(),
	resumeMode: z.enum(["resume", "fresh"]).optional(),
	baseRef: z.string(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
	agentId: runtimeAgentIdSchema.optional(),
	// Per-card model for the CLI-agent launch path; forwarded to the adapter's
	// native --model flag. Mirrors the card's agentModel override.
	agentModel: z.string().optional(),
	// Optional per-card SKILL.md pointer. This is launch guidance only; the
	// runtime never embeds the skill body in the prompt.
	skill: z.string().optional(),
	clineSettings: runtimeTaskClineSettingsSchema.optional(),
});
export type RuntimeTaskSessionStartRequest = z.infer<typeof runtimeTaskSessionStartRequestSchema>;

export const runtimeTaskSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionStartResponse = z.infer<typeof runtimeTaskSessionStartResponseSchema>;

export const runtimeTaskSessionStopRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskSessionStopRequest = z.infer<typeof runtimeTaskSessionStopRequestSchema>;

export const runtimeTaskSessionStopResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionStopResponse = z.infer<typeof runtimeTaskSessionStopResponseSchema>;

export const runtimeTaskSessionInputRequestSchema = z.object({
	taskId: z.string(),
	text: z.string(),
	appendNewline: z.boolean().optional(),
	// Steering (`fleet task say`): wrap the payload in bracketed-paste markers so a
	// mid-generation PTY agent buffers it as one paste instead of interleaving it
	// into its current turn. Ignored on the Cline path, which takes input as a
	// discrete message. Additive/optional so existing callers (live terminal typing)
	// keep raw-byte behavior.
	bracketedPaste: z.boolean().optional(),
	// Only meaningful with bracketedPaste: append the paste terminator + carriage
	// return to submit the staged text. false stages it without submitting.
	submit: z.boolean().optional(),
});
export type RuntimeTaskSessionInputRequest = z.infer<typeof runtimeTaskSessionInputRequestSchema>;

export const runtimeTaskSessionInputResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskSessionInputResponse = z.infer<typeof runtimeTaskSessionInputResponseSchema>;

export const runtimeTaskChatMessageSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant", "system", "tool", "reasoning", "status"]),
	content: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	createdAt: z.number(),
	meta: z
		.object({
			toolName: z.string().nullable().optional(),
			hookEventName: z.string().nullable().optional(),
			toolCallId: z.string().nullable().optional(),
			streamType: z.string().nullable().optional(),
			messageKind: z.string().nullable().optional(),
			displayRole: z.string().nullable().optional(),
			reason: z.string().nullable().optional(),
		})
		.nullable()
		.optional(),
});
export type RuntimeTaskChatMessage = z.infer<typeof runtimeTaskChatMessageSchema>;

export const runtimeTaskChatMessagesRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatMessagesRequest = z.infer<typeof runtimeTaskChatMessagesRequestSchema>;

export const runtimeTaskChatMessagesResponseSchema = z.object({
	ok: z.boolean(),
	messages: z.array(runtimeTaskChatMessageSchema),
	error: z.string().optional(),
});
export type RuntimeTaskChatMessagesResponse = z.infer<typeof runtimeTaskChatMessagesResponseSchema>;

export const runtimeTaskTranscriptRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskTranscriptRequest = z.infer<typeof runtimeTaskTranscriptRequestSchema>;

export const runtimeTaskTranscriptResponseSchema = z.object({
	ok: z.boolean(),
	// True when a transcript file was located on disk. `false` with an empty
	// `messages` list is the graceful "conversation no longer on disk" signal —
	// never a silently-started fresh session.
	present: z.boolean(),
	messages: z.array(runtimeTaskChatMessageSchema),
	error: z.string().optional(),
});
export type RuntimeTaskTranscriptResponse = z.infer<typeof runtimeTaskTranscriptResponseSchema>;

/**
 * One normalized token-usage total per card, derived on read from the agent's
 * own transcript (never separately tracked). Field names/meanings deliberately
 * match Cline's `SessionAccumulatedUsage` (the SDK source of truth) so the Cline
 * path can pass through — `cacheCreationTokens` is Cline's `cacheWriteTokens`
 * renamed (prompt-cache writes; from Claude's `cache_creation_input_tokens`).
 * `costUsd` is `null` until a model price table lands (a later card); the four
 * token fields are counted independently and never subtracted from one another.
 */
export const runtimeTaskTokenUsageSchema = z.object({
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadTokens: z.number(),
	cacheCreationTokens: z.number(),
	costUsd: z.number().nullable(),
});
export type RuntimeTaskTokenUsage = z.infer<typeof runtimeTaskTokenUsageSchema>;

export const runtimeTaskTokenUsageRequestSchema = z.object({
	taskIds: z.array(z.string()),
});
export type RuntimeTaskTokenUsageRequest = z.infer<typeof runtimeTaskTokenUsageRequestSchema>;

export const runtimeTaskTokenUsageResponseSchema = z.object({
	ok: z.boolean(),
	// One entry per requested task id: the normalized usage, or `null` when the
	// card has no resolvable session (or no usage on disk yet). Keyed by task id
	// so a single round-trip covers every currently-rendered card.
	usage: z.record(z.string(), runtimeTaskTokenUsageSchema.nullable()),
	error: z.string().optional(),
});
export type RuntimeTaskTokenUsageResponse = z.infer<typeof runtimeTaskTokenUsageResponseSchema>;

export const runtimeTaskChatSendRequestSchema = z.object({
	taskId: z.string(),
	text: z.string(),
	images: z.array(runtimeTaskImageSchema).optional(),
	mode: runtimeTaskSessionModeSchema.optional(),
});
export type RuntimeTaskChatSendRequest = z.infer<typeof runtimeTaskChatSendRequestSchema>;

export const runtimeTaskChatSendResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	message: runtimeTaskChatMessageSchema.nullable().optional(),
	error: z.string().optional(),
});
export type RuntimeTaskChatSendResponse = z.infer<typeof runtimeTaskChatSendResponseSchema>;

export const runtimeTaskChatReloadRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatReloadRequest = z.infer<typeof runtimeTaskChatReloadRequestSchema>;

export const runtimeTaskChatReloadResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatReloadResponse = z.infer<typeof runtimeTaskChatReloadResponseSchema>;

export const runtimeTaskChatAbortRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatAbortRequest = z.infer<typeof runtimeTaskChatAbortRequestSchema>;

export const runtimeTaskChatAbortResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatAbortResponse = z.infer<typeof runtimeTaskChatAbortResponseSchema>;

export const runtimeTaskChatCancelRequestSchema = z.object({
	taskId: z.string(),
});
export type RuntimeTaskChatCancelRequest = z.infer<typeof runtimeTaskChatCancelRequestSchema>;

export const runtimeTaskChatCancelResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	error: z.string().optional(),
});
export type RuntimeTaskChatCancelResponse = z.infer<typeof runtimeTaskChatCancelResponseSchema>;

export const runtimeShellSessionStartRequestSchema = z.object({
	taskId: z.string(),
	cols: z.number().int().positive().optional(),
	rows: z.number().int().positive().optional(),
	workspaceTaskId: z.string().optional(),
	baseRef: z.string(),
});
export type RuntimeShellSessionStartRequest = z.infer<typeof runtimeShellSessionStartRequestSchema>;

export const runtimeShellSessionStartResponseSchema = z.object({
	ok: z.boolean(),
	summary: runtimeTaskSessionSummarySchema.nullable(),
	shellBinary: z.string().nullable().optional(),
	error: z.string().optional(),
});
export type RuntimeShellSessionStartResponse = z.infer<typeof runtimeShellSessionStartResponseSchema>;

export const runtimeTerminalWsResizeMessageSchema = z.object({
	type: z.literal("resize"),
	cols: z.number().int().positive(),
	rows: z.number().int().positive(),
	pixelWidth: z.number().int().positive().optional(),
	pixelHeight: z.number().int().positive().optional(),
});
export type RuntimeTerminalWsResizeMessage = z.infer<typeof runtimeTerminalWsResizeMessageSchema>;

export const runtimeTerminalWsStopMessageSchema = z.object({
	type: z.literal("stop"),
});
export type RuntimeTerminalWsStopMessage = z.infer<typeof runtimeTerminalWsStopMessageSchema>;

export const runtimeTerminalWsOutputAckMessageSchema = z.object({
	type: z.literal("output_ack"),
	bytes: z.number().int().nonnegative(),
});
export type RuntimeTerminalWsOutputAckMessage = z.infer<typeof runtimeTerminalWsOutputAckMessageSchema>;

export const runtimeTerminalWsRestoreCompleteMessageSchema = z.object({
	type: z.literal("restore_complete"),
});
export type RuntimeTerminalWsRestoreCompleteMessage = z.infer<typeof runtimeTerminalWsRestoreCompleteMessageSchema>;

export const runtimeTerminalWsClientMessageSchema = z.discriminatedUnion("type", [
	runtimeTerminalWsResizeMessageSchema,
	runtimeTerminalWsStopMessageSchema,
	runtimeTerminalWsOutputAckMessageSchema,
	runtimeTerminalWsRestoreCompleteMessageSchema,
]);
export type RuntimeTerminalWsClientMessage = z.infer<typeof runtimeTerminalWsClientMessageSchema>;

export const runtimeTerminalWsStateMessageSchema = z.object({
	type: z.literal("state"),
	summary: runtimeTaskSessionSummarySchema,
});
export type RuntimeTerminalWsStateMessage = z.infer<typeof runtimeTerminalWsStateMessageSchema>;

export const runtimeTerminalWsErrorMessageSchema = z.object({
	type: z.literal("error"),
	message: z.string(),
});
export type RuntimeTerminalWsErrorMessage = z.infer<typeof runtimeTerminalWsErrorMessageSchema>;

export const runtimeTerminalWsExitMessageSchema = z.object({
	type: z.literal("exit"),
	code: z.number().nullable(),
});
export type RuntimeTerminalWsExitMessage = z.infer<typeof runtimeTerminalWsExitMessageSchema>;

export const runtimeTerminalWsRestoreMessageSchema = z.object({
	type: z.literal("restore"),
	snapshot: z.string(),
	cols: z.number().int().positive().nullable().optional(),
	rows: z.number().int().positive().nullable().optional(),
});
export type RuntimeTerminalWsRestoreMessage = z.infer<typeof runtimeTerminalWsRestoreMessageSchema>;

export const runtimeTerminalWsServerMessageSchema = z.discriminatedUnion("type", [
	runtimeTerminalWsStateMessageSchema,
	runtimeTerminalWsErrorMessageSchema,
	runtimeTerminalWsExitMessageSchema,
	runtimeTerminalWsRestoreMessageSchema,
]);
export type RuntimeTerminalWsServerMessage = z.infer<typeof runtimeTerminalWsServerMessageSchema>;

export const runtimeGitCommitSchema = z.object({
	hash: z.string(),
	shortHash: z.string(),
	authorName: z.string(),
	authorEmail: z.string(),
	date: z.string(),
	message: z.string(),
	parentHashes: z.array(z.string()),
	relation: z.enum(["selected", "upstream", "shared"]).optional(),
});
export type RuntimeGitCommit = z.infer<typeof runtimeGitCommitSchema>;

export const runtimeGitRefSchema = z.object({
	name: z.string(),
	type: z.enum(["branch", "remote", "detached"]),
	hash: z.string(),
	isHead: z.boolean(),
	upstreamName: z.string().optional(),
	ahead: z.number().optional(),
	behind: z.number().optional(),
});
export type RuntimeGitRef = z.infer<typeof runtimeGitRefSchema>;

export const runtimeGitLogRequestSchema = z.object({
	ref: z.string().nullable().optional(),
	refs: z.array(z.string()).optional(),
	maxCount: z.number().int().positive().optional(),
	skip: z.number().int().nonnegative().optional(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitLogRequest = z.infer<typeof runtimeGitLogRequestSchema>;

export const runtimeGitLogResponseSchema = z.object({
	ok: z.boolean(),
	commits: z.array(runtimeGitCommitSchema),
	totalCount: z.number(),
	error: z.string().optional(),
});
export type RuntimeGitLogResponse = z.infer<typeof runtimeGitLogResponseSchema>;

export const runtimeGitCommitDiffFileSchema = z.object({
	path: z.string(),
	previousPath: z.string().optional(),
	status: z.enum(["modified", "added", "deleted", "renamed"]),
	additions: z.number(),
	deletions: z.number(),
	patch: z.string(),
});
export type RuntimeGitCommitDiffFile = z.infer<typeof runtimeGitCommitDiffFileSchema>;

export const runtimeGitCommitDiffRequestSchema = z.object({
	commitHash: z.string(),
	taskScope: runtimeTaskWorkspaceInfoRequestSchema.nullable().optional(),
});
export type RuntimeGitCommitDiffRequest = z.infer<typeof runtimeGitCommitDiffRequestSchema>;

export const runtimeGitCommitDiffResponseSchema = z.object({
	ok: z.boolean(),
	commitHash: z.string(),
	files: z.array(runtimeGitCommitDiffFileSchema),
	error: z.string().optional(),
});
export type RuntimeGitCommitDiffResponse = z.infer<typeof runtimeGitCommitDiffResponseSchema>;

export const runtimeGitRefsResponseSchema = z.object({
	ok: z.boolean(),
	refs: z.array(runtimeGitRefSchema),
	error: z.string().optional(),
});
export type RuntimeGitRefsResponse = z.infer<typeof runtimeGitRefsResponseSchema>;

export const runtimeHookEventSchema = z.enum(["to_review", "to_in_progress", "activity"]);
export type RuntimeHookEvent = z.infer<typeof runtimeHookEventSchema>;

export const runtimeHookIngestRequestSchema = z.object({
	taskId: z.string(),
	workspaceId: z.string(),
	event: runtimeHookEventSchema,
	metadata: runtimeTaskHookActivitySchema.partial().optional(),
});
export type RuntimeHookIngestRequest = z.infer<typeof runtimeHookIngestRequestSchema>;

export const runtimeHookIngestResponseSchema = z.object({
	ok: z.boolean(),
	error: z.string().optional(),
});
export type RuntimeHookIngestResponse = z.infer<typeof runtimeHookIngestResponseSchema>;
