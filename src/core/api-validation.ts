import { z } from "zod";

import {
	type RuntimeCommandRunRequest,
	type RuntimeConfigSaveRequest,
	type RuntimeDesignDocRequest,
	type RuntimeDirectoryListRequest,
	type RuntimeGitCheckoutRequest,
	type RuntimeHomeAgentFreshStartRequest,
	type RuntimeHookIngestRequest,
	type RuntimeProjectAddRequest,
	type RuntimeProjectRemoveRequest,
	type RuntimeShellSessionStartRequest,
	type RuntimeTaskChatAbortRequest,
	type RuntimeTaskChatCancelRequest,
	type RuntimeTaskChatMessagesRequest,
	type RuntimeTaskChatReloadRequest,
	type RuntimeTaskChatSendRequest,
	type RuntimeTaskDurabilityRequest,
	type RuntimeTaskFileRequest,
	type RuntimeTaskReviewNotificationRequest,
	type RuntimeTaskSessionInputRequest,
	type RuntimeTaskSessionStartRequest,
	type RuntimeTaskSessionStopRequest,
	type RuntimeTaskTokenUsageRequest,
	type RuntimeTaskTranscriptRequest,
	type RuntimeTaskWorkspaceInfoRequest,
	type RuntimeTerminalWsClientMessage,
	type RuntimeWorkspaceChangesRequest,
	type RuntimeWorkspaceFileSearchRequest,
	type RuntimeWorkspaceStateSaveRequest,
	type RuntimeWorktreeDeleteRequest,
	type RuntimeWorktreeEnsureRequest,
	runtimeCommandRunRequestSchema,
	runtimeConfigSaveRequestSchema,
	runtimeDesignDocRequestSchema,
	runtimeDirectoryListRequestSchema,
	runtimeGitCheckoutRequestSchema,
	runtimeHomeAgentFreshStartRequestSchema,
	runtimeHookIngestRequestSchema,
	runtimeProjectAddRequestSchema,
	runtimeProjectRemoveRequestSchema,
	runtimeShellSessionStartRequestSchema,
	runtimeTaskChatAbortRequestSchema,
	runtimeTaskChatCancelRequestSchema,
	runtimeTaskChatMessagesRequestSchema,
	runtimeTaskChatReloadRequestSchema,
	runtimeTaskChatSendRequestSchema,
	runtimeTaskDurabilityRequestSchema,
	runtimeTaskFileRequestSchema,
	runtimeTaskReviewNotificationRequestSchema,
	runtimeTaskSessionInputRequestSchema,
	runtimeTaskSessionStartRequestSchema,
	runtimeTaskSessionStopRequestSchema,
	runtimeTaskTokenUsageRequestSchema,
	runtimeTaskTranscriptRequestSchema,
	runtimeTaskWorkspaceInfoRequestSchema,
	runtimeTerminalWsClientMessageSchema,
	runtimeWorkspaceChangesRequestSchema,
	runtimeWorkspaceFileSearchRequestSchema,
	runtimeWorkspaceStateSaveRequestSchema,
	runtimeWorktreeDeleteRequestSchema,
	runtimeWorktreeEnsureRequestSchema,
} from "./api-contract";

const trimmedStringSchema = z.string().transform((value) => value.trim());
const positiveIntegerFromQuerySchema = z.coerce.number().int().positive();

const requiredTrimmedStringSchema = (message: string) => trimmedStringSchema.pipe(z.string().min(1, message));

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new Error(parsed.error.issues[0]?.message ?? "Invalid request payload.");
	}
	return parsed.data;
}

export function parseWorkspaceChangesRequest(query: URLSearchParams): RuntimeWorkspaceChangesRequest {
	const taskId = parseWithSchema(
		requiredTrimmedStringSchema("Missing taskId query parameter."),
		query.get("taskId") ?? "",
	);
	const baseRef = parseWithSchema(
		requiredTrimmedStringSchema("Missing baseRef query parameter."),
		query.get("baseRef") ?? "",
	);
	return parseWithSchema(runtimeWorkspaceChangesRequestSchema, { taskId, baseRef });
}

export function parseTaskWorkspaceInfoRequest(query: URLSearchParams): RuntimeTaskWorkspaceInfoRequest {
	const taskId = parseWithSchema(
		requiredTrimmedStringSchema("Missing taskId query parameter."),
		query.get("taskId") ?? "",
	);
	const baseRef = parseWithSchema(
		requiredTrimmedStringSchema("Missing baseRef query parameter."),
		query.get("baseRef") ?? "",
	);
	return parseWithSchema(runtimeTaskWorkspaceInfoRequestSchema, { taskId, baseRef });
}

export function parseOptionalTaskWorkspaceInfoRequest(query: URLSearchParams): RuntimeTaskWorkspaceInfoRequest | null {
	if (!query.has("taskId")) {
		if (query.has("baseRef")) {
			throw new Error("baseRef query parameter requires taskId.");
		}
		return null;
	}
	return parseTaskWorkspaceInfoRequest(query);
}

export function parseWorkspaceFileSearchRequest(query: URLSearchParams): RuntimeWorkspaceFileSearchRequest {
	const normalizedQuery = parseWithSchema(trimmedStringSchema, query.get("q") ?? "");
	if (!normalizedQuery) {
		return { query: "" };
	}

	const rawLimit = query.get("limit");
	if (rawLimit == null || rawLimit.trim() === "") {
		return parseWithSchema(runtimeWorkspaceFileSearchRequestSchema, {
			query: normalizedQuery,
		});
	}
	const parsedLimit = positiveIntegerFromQuerySchema.safeParse(rawLimit);
	if (!parsedLimit.success) {
		throw new Error("Invalid file search limit parameter.");
	}
	return parseWithSchema(runtimeWorkspaceFileSearchRequestSchema, {
		query: normalizedQuery,
		limit: parsedLimit.data,
	});
}

export function parseDesignDocRequest(value: unknown): RuntimeDesignDocRequest {
	const parsed = parseWithSchema(runtimeDesignDocRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid design doc payload.");
	}
	const externalIssueKey = parsed.externalIssueKey?.trim() || undefined;
	return {
		taskId,
		...(externalIssueKey ? { externalIssueKey } : {}),
	};
}

export function parseTaskFileRequest(value: unknown): RuntimeTaskFileRequest {
	const parsed = parseWithSchema(runtimeTaskFileRequestSchema, value);
	const taskId = parsed.taskId.trim();
	const path = parsed.path.trim();
	if (!taskId || !path) {
		throw new Error("Invalid task file payload.");
	}
	return { taskId, path };
}

export function parseGitCheckoutRequest(value: unknown): RuntimeGitCheckoutRequest {
	const parsed = parseWithSchema(runtimeGitCheckoutRequestSchema, value);
	const branch = parsed.branch.trim();
	if (!branch) {
		throw new Error("Branch cannot be empty.");
	}
	return {
		branch,
	};
}

export function parseWorktreeEnsureRequest(value: unknown): RuntimeWorktreeEnsureRequest {
	const parsed = parseWithSchema(runtimeWorktreeEnsureRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid worktree ensure payload.");
	}
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Invalid worktree ensure payload.");
	}
	return {
		taskId,
		baseRef,
	};
}

export function parseWorktreeDeleteRequest(value: unknown): RuntimeWorktreeDeleteRequest {
	const parsed = parseWithSchema(runtimeWorktreeDeleteRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid worktree delete payload.");
	}
	return {
		taskId,
		...(parsed.discard === true ? { discard: true } : {}),
	};
}

export function parseTaskDurabilityRequest(value: unknown): RuntimeTaskDurabilityRequest {
	const parsed = parseWithSchema(runtimeTaskDurabilityRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid task durability payload.");
	}
	return {
		taskId,
	};
}

export function parseWorkspaceStateSaveRequest(value: unknown): RuntimeWorkspaceStateSaveRequest {
	return parseWithSchema(runtimeWorkspaceStateSaveRequestSchema, value);
}

export function parseProjectAddRequest(value: unknown): RuntimeProjectAddRequest {
	const parsed = parseWithSchema(runtimeProjectAddRequestSchema, value);
	const path = parsed.path?.trim() || undefined;
	const gitUrl = parsed.gitUrl?.trim() || undefined;
	if (!path && !gitUrl) {
		throw new Error("Either path or gitUrl is required.");
	}
	return {
		path,
		gitUrl,
		initializeGit: parsed.initializeGit,
	};
}

export function parseProjectRemoveRequest(value: unknown): RuntimeProjectRemoveRequest {
	const parsed = parseWithSchema(runtimeProjectRemoveRequestSchema, value);
	const projectId = parsed.projectId.trim();
	if (!projectId) {
		throw new Error("Project ID cannot be empty.");
	}
	return {
		projectId,
	};
}

export function parseRuntimeConfigSaveRequest(value: unknown): RuntimeConfigSaveRequest {
	return parseWithSchema(runtimeConfigSaveRequestSchema, value);
}

export function parseCommandRunRequest(value: unknown): RuntimeCommandRunRequest {
	const parsed = parseWithSchema(runtimeCommandRunRequestSchema, value);
	const command = parsed.command.trim();
	if (!command) {
		throw new Error("Command cannot be empty.");
	}
	return {
		command,
	};
}

export function parseTaskSessionStartRequest(value: unknown): RuntimeTaskSessionStartRequest {
	const parsed = parseWithSchema(runtimeTaskSessionStartRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task session taskId cannot be empty.");
	}
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Task session baseRef cannot be empty.");
	}
	return {
		...parsed,
		taskId,
		baseRef,
	};
}

export function parseTaskSessionStopRequest(value: unknown): RuntimeTaskSessionStopRequest {
	const parsed = parseWithSchema(runtimeTaskSessionStopRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid task session stop payload.");
	}
	return {
		taskId,
	};
}

export function parseHomeAgentFreshStartRequest(value: unknown): RuntimeHomeAgentFreshStartRequest {
	const parsed = parseWithSchema(runtimeHomeAgentFreshStartRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Invalid home agent fresh-start payload.");
	}
	return {
		taskId,
	};
}

export function parseTaskSessionInputRequest(value: unknown): RuntimeTaskSessionInputRequest {
	const parsed = parseWithSchema(runtimeTaskSessionInputRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task session taskId cannot be empty.");
	}
	return {
		...parsed,
		taskId,
	};
}

export function parseTaskReviewNotificationRequest(value: unknown): RuntimeTaskReviewNotificationRequest {
	const parsed = parseWithSchema(runtimeTaskReviewNotificationRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task ID cannot be empty.");
	}
	return {
		taskId,
	};
}

export function parseTaskChatMessagesRequest(value: unknown): RuntimeTaskChatMessagesRequest {
	const parsed = parseWithSchema(runtimeTaskChatMessagesRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	return {
		taskId,
	};
}

export function parseTaskTranscriptRequest(value: unknown): RuntimeTaskTranscriptRequest {
	const parsed = parseWithSchema(runtimeTaskTranscriptRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task transcript taskId cannot be empty.");
	}
	return {
		taskId,
	};
}

export function parseTaskTokenUsageRequest(value: unknown): RuntimeTaskTokenUsageRequest {
	const parsed = parseWithSchema(runtimeTaskTokenUsageRequestSchema, value);
	// Trim and drop blanks so the batch only carries usable ids; duplicates are
	// harmless (the response is keyed by id) but empty strings never are.
	const taskIds = parsed.taskIds.map((taskId) => taskId.trim()).filter(Boolean);
	return {
		taskIds,
	};
}

export function parseTaskChatSendRequest(value: unknown): RuntimeTaskChatSendRequest {
	const parsed = parseWithSchema(runtimeTaskChatSendRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	const text = parsed.text.trim();
	const hasImages = Boolean(parsed.images && parsed.images.length > 0);
	if (!text && !hasImages) {
		throw new Error("Task chat text or images are required.");
	}
	return {
		...parsed,
		taskId,
		text,
	};
}

export function parseTaskChatAbortRequest(value: unknown): RuntimeTaskChatAbortRequest {
	const parsed = parseWithSchema(runtimeTaskChatAbortRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	return {
		taskId,
	};
}

export function parseTaskChatReloadRequest(value: unknown): RuntimeTaskChatReloadRequest {
	const parsed = parseWithSchema(runtimeTaskChatReloadRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	return {
		taskId,
	};
}

export function parseTaskChatCancelRequest(value: unknown): RuntimeTaskChatCancelRequest {
	const parsed = parseWithSchema(runtimeTaskChatCancelRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Task chat taskId cannot be empty.");
	}
	return {
		taskId,
	};
}

export function parseShellSessionStartRequest(value: unknown): RuntimeShellSessionStartRequest {
	const parsed = parseWithSchema(runtimeShellSessionStartRequestSchema, value);
	const taskId = parsed.taskId.trim();
	if (!taskId) {
		throw new Error("Shell session taskId cannot be empty.");
	}
	if (parsed.workspaceTaskId !== undefined && !parsed.workspaceTaskId.trim()) {
		throw new Error("Invalid shell session workspaceTaskId.");
	}
	const workspaceTaskId = parsed.workspaceTaskId?.trim() || undefined;
	const baseRef = parsed.baseRef.trim();
	if (!baseRef) {
		throw new Error("Shell session baseRef cannot be empty.");
	}
	return {
		...parsed,
		taskId,
		workspaceTaskId,
		baseRef,
	};
}

export function parseHookIngestRequest(value: unknown): RuntimeHookIngestRequest {
	const parsed = parseWithSchema(runtimeHookIngestRequestSchema, value);
	const taskId = parsed.taskId.trim();
	const workspaceId = parsed.workspaceId.trim();
	if (!taskId) {
		throw new Error("Missing taskId");
	}
	if (!workspaceId) {
		throw new Error("Missing workspaceId");
	}
	const metadata = parsed.metadata
		? {
				activityText: parsed.metadata.activityText?.trim(),
				toolName: parsed.metadata.toolName?.trim(),
				finalMessage: parsed.metadata.finalMessage?.trim(),
				hookEventName: parsed.metadata.hookEventName?.trim(),
				notificationType: parsed.metadata.notificationType?.trim(),
				source: parsed.metadata.source?.trim(),
			}
		: undefined;
	return {
		...parsed,
		taskId,
		workspaceId,
		metadata,
	};
}

export function parseTerminalWsClientMessage(value: unknown): RuntimeTerminalWsClientMessage | null {
	const parsed = runtimeTerminalWsClientMessageSchema.safeParse(value);
	if (!parsed.success) {
		return null;
	}
	return parsed.data;
}

export function parseDirectoryListRequest(value: unknown): RuntimeDirectoryListRequest {
	return parseWithSchema(runtimeDirectoryListRequestSchema, value);
}
