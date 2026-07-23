import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseRuntimeStateStreamResult } from "@/runtime/use-runtime-state-stream";
import { useRuntimeStateStream } from "@/runtime/use-runtime-state-stream";

const useDocumentVisibilityMock = vi.fn(() => true);
vi.mock("@/hooks/use-document-visibility", () => ({
	useDocumentVisibility: () => useDocumentVisibilityMock(),
}));

class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	static instances: MockWebSocket[] = [];
	readyState = 0; // CONNECTING
	url: string;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	closeCalled = false;

	constructor(url: string) {
		this.url = url;
		MockWebSocket.instances.push(this);
	}

	open() {
		this.readyState = 1; // OPEN
		if (this.onopen) {
			this.onopen();
		}
	}

	close() {
		this.closeCalled = true;
		this.readyState = 3; // CLOSED
		if (this.onclose) {
			this.onclose();
		}
	}

	send() {}
}

const originalWebSocket = globalThis.WebSocket;

interface HarnessProps {
	requestedWorkspaceId: string | null;
	enabled?: boolean;
	pinned?: boolean;
	onSnapshot: (snapshot: UseRuntimeStateStreamResult) => void;
}

function HookHarness({ requestedWorkspaceId, enabled, pinned, onSnapshot }: HarnessProps) {
	const result = useRuntimeStateStream(requestedWorkspaceId, { enabled, pinned });
	onSnapshot(result);
	return null;
}

describe("useRuntimeStateStream - heartbeat and liveness watchdog", () => {
	let container: HTMLDivElement;
	let root: Root;
	let latestSnapshot: UseRuntimeStateStreamResult;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		MockWebSocket.instances = [];
		globalThis.WebSocket = MockWebSocket as any;
		useDocumentVisibilityMock.mockReturnValue(true);

		previousActEnvironment = (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
		(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

		vi.useFakeTimers();

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		globalThis.WebSocket = originalWebSocket;
		(globalThis as any).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	const renderHook = (props: Partial<HarnessProps> = {}) => {
		act(() => {
			root.render(
				<HookHarness
					requestedWorkspaceId={props.requestedWorkspaceId ?? "workspace-a"}
					enabled={props.enabled}
					pinned={props.pinned}
					onSnapshot={(s) => {
						latestSnapshot = s;
					}}
				/>,
			);
		});
	};

	it("given an opened socket and received snapshot, when no messages arrive for longer than the staleness window, then it treats the socket as dead and reconnects", () => {
		renderHook();
		expect(MockWebSocket.instances.length).toBe(1);
		const ws = MockWebSocket.instances[0]!;

		// 1. Open the socket
		act(() => {
			ws.open();
		});

		// 2. Send the snapshot message to complete initialization
		act(() => {
			ws.onmessage?.({
				data: JSON.stringify({
					type: "snapshot",
					currentProjectId: "workspace-a",
					projects: [],
					architectWorkspaceId: null,
					workspaceState: null,
					workspaceMetadata: null,
					clineSessionContextVersion: 1,
				}),
			});
		});

		expect(latestSnapshot.hasReceivedSnapshot).toBe(true);
		expect(MockWebSocket.instances.length).toBe(1);

		// 3. Fast-forward past the staleness watchdog window (60s)
		act(() => {
			vi.advanceTimersByTime(65_000);
		});

		// 4. A new WebSocket instance should have been constructed (reconnect)
		expect(MockWebSocket.instances.length).toBeGreaterThan(1);
		expect(ws.closeCalled).toBe(true);
	});

	it("given an opened socket and received snapshot, when regular messages arrive within the staleness window, then it does not trigger reconnects", () => {
		renderHook();
		expect(MockWebSocket.instances.length).toBe(1);
		const ws = MockWebSocket.instances[0]!;

		act(() => {
			ws.open();
		});

		act(() => {
			ws.onmessage?.({
				data: JSON.stringify({
					type: "snapshot",
					currentProjectId: "workspace-a",
					projects: [],
					architectWorkspaceId: null,
					workspaceState: null,
					workspaceMetadata: null,
					clineSessionContextVersion: 1,
				}),
			});
		});

		// Advance timer by 40s (less than the 60s staleness window)
		act(() => {
			vi.advanceTimersByTime(40_000);
		});
		expect(MockWebSocket.instances.length).toBe(1);

		// Send a live state update message to reset the staleness watchdog
		act(() => {
			ws.onmessage?.({
				data: JSON.stringify({
					type: "workspace_state_updated",
					workspaceId: "workspace-a",
					workspaceState: {
						revision: 2,
						board: { columns: [] },
					},
				}),
			});
		});

		// Advance another 40s (total 80s, but only 40s since the last message)
		act(() => {
			vi.advanceTimersByTime(40_000);
		});

		// No reconnect should have happened
		expect(MockWebSocket.instances.length).toBe(1);
		expect(ws.closeCalled).toBe(false);
	});

	it("given the tab changes from hidden to visible, when the socket is closed, then it forces an immediate reconnect", () => {
		useDocumentVisibilityMock.mockReturnValue(false);
		renderHook();
		const ws = MockWebSocket.instances[0]!;

		act(() => {
			ws.open();
		});

		// Simulate socket close
		act(() => {
			ws.close();
		});

		const instancesAfterClose = MockWebSocket.instances.length;

		// Trigger tab focus (visibilitychange to visible)
		useDocumentVisibilityMock.mockReturnValue(true);
		act(() => {
			// Trigger a re-render to pick up the mocked visibilitychange
			renderHook();
		});

		// Reconnect should have been triggered immediately instead of waiting for reconnect timeout
		expect(MockWebSocket.instances.length).toBeGreaterThan(instancesAfterClose);
	});

	it("given the tab changes from hidden to visible, when the socket is healthy and OPEN, then it does not force a reconnect", () => {
		useDocumentVisibilityMock.mockReturnValue(false);
		renderHook();
		const ws = MockWebSocket.instances[0]!;

		act(() => {
			ws.open();
		});

		act(() => {
			ws.onmessage?.({
				data: JSON.stringify({
					type: "snapshot",
					currentProjectId: "workspace-a",
					projects: [],
					architectWorkspaceId: null,
					workspaceState: null,
					workspaceMetadata: null,
					clineSessionContextVersion: 1,
				}),
			});
		});

		const countBefore = MockWebSocket.instances.length;

		// Tab becomes visible
		useDocumentVisibilityMock.mockReturnValue(true);
		act(() => {
			renderHook();
		});

		// No reconnect should be forced because socket is healthy and OPEN
		expect(MockWebSocket.instances.length).toBe(countBefore);
		expect(ws.closeCalled).toBe(false);
	});
});
