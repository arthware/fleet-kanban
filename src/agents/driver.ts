import { RUNTIME_AGENT_CATALOG, type RuntimeAgentCatalogEntry } from "../core/agent-catalog";
import type { RuntimeAgentId, RuntimeAgentSessionLifecycle } from "../core/api-contract";
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
	readonly prompt: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly model: string | null;
}

export interface LaunchPlan {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: Readonly<Record<string, string>>;
}

export interface LaunchPort {
	preflight(): Promise<Capability<LaunchPreflight>>;
	prepare(input: LaunchRequest): Promise<Capability<LaunchPlan>>;
	applyModel(args: readonly string[], model: string): Capability<readonly string[]>;
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

export interface ObservationPort {
	artifactPresent(): Promise<Capability<boolean>>;
	messages(): Promise<Capability<readonly AgentObservationMessage[]>>;
	usage(): Promise<Capability<AgentUsage>>;
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
	claude: createUnboundAgentDriver(catalogEntryById("claude")),
	codex: createUnboundAgentDriver(catalogEntryById("codex")),
	cursor: createUnboundAgentDriver(catalogEntryById("cursor")),
	gemini: createUnboundAgentDriver(catalogEntryById("gemini")),
	opencode: createUnboundAgentDriver(catalogEntryById("opencode")),
	droid: createUnboundAgentDriver(catalogEntryById("droid")),
	kiro: createUnboundAgentDriver(catalogEntryById("kiro")),
	cline: createUnboundAgentDriver(catalogEntryById("cline")),
} satisfies Record<RuntimeAgentId, AgentDriver>;

function catalogEntryById(agentId: RuntimeAgentId): RuntimeAgentCatalogEntry {
	const entry = RUNTIME_AGENT_CATALOG.find((candidate) => candidate.id === agentId);
	if (!entry) {
		throw new Error(`Missing catalog entry for ${agentId}`);
	}
	return entry;
}

function createUnboundAgentDriver(catalog: RuntimeAgentCatalogEntry): AgentDriver {
	const reason = `${catalog.id} driver is not bound yet`;

	return {
		id: catalog.id,
		catalog,
		launch: {
			preflight: async () => unsupported(reason),
			prepare: async () => unsupported(reason),
			applyModel: () => unsupported(reason),
		},
		identity: {
			durability: "none",
			resolve: () => unsupported(reason),
		},
		observe: {
			artifactPresent: async () => unsupported(reason),
			messages: async () => unsupported(reason),
			usage: async () => unsupported(reason),
		},
		signals: {
			mapNativeSignal: () => unsupported(reason),
			attentionSupport: () => unsupported(reason),
		},
		control: {
			steer: async () => unsupported(reason),
			interrupt: async () => unsupported(reason),
		},
	};
}
