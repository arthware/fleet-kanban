import type {
	AgentDriver,
	AgentObservationMessage,
	LaunchIdentityPlan,
	NativeSignalInput,
	SteerPlan,
	SteerStep,
} from "../../../src/agents/driver";
import { supported, unsupported } from "../../../src/agents/driver";
import type { SessionSignal } from "../../../src/agents/session-signal";
import type { RuntimeTaskChatMessage } from "../../../src/core/api-contract";
import type { DriverFixtures } from "../tck/driver-tck";

const fakeRichMessages: readonly RuntimeTaskChatMessage[] = [
	{ id: "fake-0", role: "user", content: "Please inspect the workspace.", createdAt: 1000 },
	{ id: "fake-1", role: "assistant", content: "Inspection complete.", createdAt: 1000 },
];

const fakeMessages: readonly AgentObservationMessage[] = [
	{ role: "user", text: "Please inspect the workspace." },
	{ role: "assistant", text: "Inspection complete." },
];

export const FAKE_DRIVER_FIXTURES: DriverFixtures = {
	nativeSignals: [
		{ name: "fake.turn.started", payload: {}, expectedFactType: "turn.started" },
		{ name: "fake.progress", payload: {}, expectedFactType: "progress" },
		{ name: "fake.attention.required", payload: { cause: "question" }, expectedFactType: "attention.required" },
		{ name: "fake.turn.ended", payload: { finalMessage: "Inspection complete." }, expectedFactType: "turn.ended" },
		{ name: "fake.session.ended", payload: { outcome: "completed" }, expectedFactType: "session.ended" },
	],
	observation: {
		expectedMessages: fakeMessages,
	},
	identity: {
		card: { kind: "card", taskId: "card-123" },
		overseer: { kind: "overseer", taskId: "home:workspace-123", workspaceId: "workspace-123" },
		generation: 2,
	},
};

export function createFakeAgentDriver(): AgentDriver {
	return {
		id: "claude",
		catalog: {
			id: "claude",
			label: "Fake Agent",
			shortLabel: "Fake",
			binary: "fake-agent",
			baseArgs: [],
			autonomousArgs: [],
			installUrl: "https://example.invalid/fake-agent",
		},
		launch: {
			preflight: async () => supported({ ok: true }),
			prepare: async (input) =>
				supported({
					command: "fake-agent",
					args: [input.prompt],
					env: input.env,
				}),
			applyModel: (args, model) => supported([...args, "--model", model]),
		},
		identity: {
			durability: "deterministic",
			resolve: (input) =>
				supported({
					agentSessionId: deterministicFakeSessionId(input.ref.taskId, input.generation),
					resumeSession: input.lifecycle === "resumable" && input.stored !== null,
					discoverAfterSpawn: false,
					durability: "deterministic",
				} satisfies LaunchIdentityPlan),
		},
		observe: {
			artifactPresent: async () => supported(true),
			messages: async () => supported(fakeMessages),
			transcript: async () => supported(fakeRichMessages),
			usage: async () => supported({ inputTokens: 12, outputTokens: 8 }),
			richUsage: async () =>
				supported({
					inputTokens: 12,
					outputTokens: 8,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					costUsd: null,
				}),
			artifactPath: async () => null,
			discoverSession: async () => null,
		},
		signals: {
			mapNativeSignal: mapFakeNativeSignal,
			attentionSupport: () => supported(true),
		},
		control: {
			steer: async (input) => {
				const plan: SteerStep[] = [{ type: "write", data: input.text }];
				if (input.submit) {
					plan.push({ type: "wait", delayMs: 50 });
					plan.push({ type: "write", data: "\r" });
				}
				return supported(plan);
			},
			interrupt: async () => {
				const plan: SteerPlan = [{ type: "write", data: "\x03" }];
				return supported(plan);
			},
		},
	};
}

function deterministicFakeSessionId(taskId: string, generation: number): string {
	return `fake-${taskId}-${generation}`;
}

function mapFakeNativeSignal(input: NativeSignalInput) {
	const seq = fakeSignalSeq(input.name);
	const base = {
		seq,
		at: input.observedAt,
		activity: null,
	};

	switch (input.name) {
		case "fake.turn.started":
			return supported({ ...base, fact: { type: "turn.started" } } satisfies SessionSignal);
		case "fake.progress":
			return supported({ ...base, fact: { type: "progress" } } satisfies SessionSignal);
		case "fake.attention.required":
			return supported({
				...base,
				fact: { type: "attention.required", cause: "question" },
			} satisfies SessionSignal);
		case "fake.turn.ended":
			return supported({
				...base,
				fact: { type: "turn.ended", finalMessage: "Inspection complete." },
			} satisfies SessionSignal);
		case "fake.session.ended":
			return supported({
				...base,
				fact: { type: "session.ended", outcome: "completed" },
			} satisfies SessionSignal);
		default:
			return unsupported(`Fake driver does not map ${input.name}`);
	}
}

function fakeSignalSeq(name: string): number {
	switch (name) {
		case "fake.turn.started":
			return 1;
		case "fake.progress":
			return 2;
		case "fake.attention.required":
			return 3;
		case "fake.turn.ended":
			return 4;
		case "fake.session.ended":
			return 5;
		default:
			return 0;
	}
}
