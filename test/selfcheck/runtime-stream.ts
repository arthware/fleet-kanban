import { EventEmitter } from "node:events";

import { WebSocket } from "ws";

import type { RuntimeStateStreamMessage } from "../../src/core/api-contract";

export interface RuntimeStreamClient {
	waitForMessage(
		predicate: (message: RuntimeStateStreamMessage) => boolean,
		timeoutMs?: number,
	): Promise<RuntimeStateStreamMessage>;
	close(): Promise<void>;
}

export async function connectRuntimeStream(url: string): Promise<RuntimeStreamClient> {
	const socket = new WebSocket(url);
	const emitter = new EventEmitter();
	const queue: RuntimeStateStreamMessage[] = [];

	socket.on("message", (raw) => {
		try {
			queue.push(JSON.parse(String(raw)) as RuntimeStateStreamMessage);
			emitter.emit("message");
		} catch {
			// Ignore malformed messages from a failing runtime; assertions time out with context.
		}
	});

	await new Promise<void>((resolveOpen, rejectOpen) => {
		const timeoutId = setTimeout(() => rejectOpen(new Error(`Timed out connecting websocket: ${url}`)), 5_000);
		socket.once("open", () => {
			clearTimeout(timeoutId);
			resolveOpen();
		});
		socket.once("error", (error) => {
			clearTimeout(timeoutId);
			rejectOpen(error);
		});
	});

	return {
		waitForMessage: async (predicate, timeoutMs = 5_000) =>
			await new Promise((resolveMessage, rejectMessage) => {
				let settled = false;
				const tryResolve = () => {
					if (settled) {
						return;
					}
					const index = queue.findIndex(predicate);
					if (index < 0) {
						return;
					}
					const [message] = queue.splice(index, 1);
					if (!message) {
						return;
					}
					settled = true;
					clearTimeout(timeoutId);
					emitter.removeListener("message", tryResolve);
					resolveMessage(message);
				};
				const timeoutId = setTimeout(() => {
					settled = true;
					emitter.removeListener("message", tryResolve);
					rejectMessage(new Error("Timed out waiting for expected runtime stream message."));
				}, timeoutMs);
				emitter.on("message", tryResolve);
				tryResolve();
			}),
		close: async () => {
			if (socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
				return;
			}
			await new Promise<void>((resolveClose) => {
				socket.once("close", () => resolveClose());
				socket.close();
			});
		},
	};
}
