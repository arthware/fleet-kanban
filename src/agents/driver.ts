import type { RuntimeAgentCatalogEntry } from "../core/agent-catalog";
import type {
	RuntimeAgentId,
	RuntimeAgentSessionLifecycle,
	RuntimeTaskChatMessage,
	RuntimeTaskSessionSummary,
	RuntimeTaskTokenUsage,
} from "../core/api-contract";
import { createClaudeDriver } from "./claude/driver";
import { createCodexDriver } from "./codex/driver";
import { createGeminiDriver } from "./gemini/driver";
import type { SessionSignal } from "./session-signal";

export type Capability<T> =
	| { readonly supported: true; readonly value: T }
	| { readonly supported: false; readonly reason: string };

export type IdentityDurability = "deterministic" | "persisted" | "none";

export type DriverSessionRef =
	| {
			readonly kind: "card";
			readonly taskId: string;
	  }
	| {
			readonly kind: "overseer";
			readonly taskId: string;
			readonly workspaceId: string;
	  };

export interface ResolveIdentityInput {
	readonly ref: DriverSessionRef;
	readonly stored: string | null;
	readonly lifecycle: RuntimeAgentSessionLifecycle;
	readonly generation: number;
}

export interface LaunchIdentityPlan {
	readonly agentSessionId: string | null;
	readonly resumeSession: boolean;
	readonly discoverAfterSpawn: boolean;
	readonly durability: IdentityDurability;
}

export interface LaunchPreflight {
	readonly ok: true;
}

export interface LaunchRequest {
	readonly taskId: string;
	readonly prompt: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly args: readonly string[];
	readonly autonomousModeEnabled: boolean;
	readonly agentSessionId: string | null;
	readonly resumeSession: boolean;
	readonly resumeFromTrash: boolean;
	readonly agentModel: string | null; // This is the card's model override
	readonly workspaceId: string | null;
	readonly architectContextPreamble: string | null;
	readonly binary?: string;
}

export interface LaunchPlan {
	readonly binary?: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly filesToWrite?: readonly { readonly path: string; readonly content: string }[];
	readonly deferredStartupInput?: string;
	readonly detectOutputTransition?: (data: string, summary: RuntimeTaskSessionSummary) => any;
	readonly shouldInspectOutputForTransition?: (summary: RuntimeTaskSessionSummary) => boolean;
}

export interface LaunchPort {
	preflight(): Promise<Capability<LaunchPreflight>>;
	prepare(input: LaunchRequest): Promise<Capability<LaunchPlan>>;
	applyModel(args: readonly string[], model: string): Capability<readonly string[]>;
}

export function hasCliOption(args: readonly string[], optionName: string): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === optionName || arg.startsWith(`${optionName}=`)) {
			return true;
		}
	}
	return false;
}

export function withPrompt(
	args: string[],
	prompt: string,
	mode: "append" | "flag",
	flag?: string,
): { args: string[]; env: Record<string, string> } {
	const trimmed = prompt.trim();
	if (!trimmed) {
		return {
			args,
			env: {},
		};
	}
	if (mode === "flag" && flag) {
		args.push(flag, trimmed);
	} else {
		args.push(trimmed);
	}
	return {
		args,
		env: {},
	};
}

export interface IdentityPort {
	readonly durability: IdentityDurability;
	resolve(input: ResolveIdentityInput): Capability<LaunchIdentityPlan>;
}

export interface AgentObservationMessage {
	readonly role: "user" | "assistant" | "system";
	readonly text: string;
}

export interface AgentUsage {
	readonly inputTokens: number;
	readonly outputTokens: number;
}

export interface ObservationRequest {
	readonly sessionId: string;
	readonly homePath: string;
}

export interface ObservationPort {
	artifactPresent(input?: ObservationRequest): Promise<Capability<boolean>>;
	messages(input?: ObservationRequest): Promise<Capability<readonly AgentObservationMessage[]>>;
	transcript(input?: ObservationRequest): Promise<Capability<readonly RuntimeTaskChatMessage[]>>;
	usage(input?: ObservationRequest): Promise<Capability<AgentUsage>>;
	richUsage(input?: ObservationRequest): Promise<Capability<RuntimeTaskTokenUsage | null>>;
	artifactPath?(input: ObservationRequest): Promise<string | null>;
}

export interface NativeSignalInput {
	readonly name: string;
	readonly payload: unknown;
	readonly observedAt: number;
}

export interface SignalPort {
	mapNativeSignal(input: NativeSignalInput): Capability<SessionSignal>;
	attentionSupport(): Capability<true>;
}

export interface ControlRequest {
	readonly text: string;
	readonly submit: boolean;
}

export interface ControlPort {
	steer(input: ControlRequest): Promise<Capability<void>>;
	interrupt(): Promise<Capability<void>>;
}

export interface AgentDriver {
	readonly id: RuntimeAgentId;
	/** Static facts about the CLI, co-located with the behaviour they describe. */
	readonly catalog: RuntimeAgentCatalogEntry;
	readonly launch: LaunchPort;
	readonly identity: IdentityPort;
	readonly observe: ObservationPort;
	readonly signals: SignalPort;
	readonly control: ControlPort;
}

export function supported<T>(value: T): Capability<T> {
	return { supported: true, value };
}

export function unsupported<T = never>(reason: string): Capability<T> {
	return { supported: false, reason };
}

export const DRIVERS = {
	claude: createClaudeDriver(),
	codex: createCodexDriver(),
	gemini: createGeminiDriver(),
} satisfies Record<RuntimeAgentId, AgentDriver>;
