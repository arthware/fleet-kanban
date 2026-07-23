import { useCallback, useEffect, useRef, useState } from "react";

import { applyFleetUpdate, fetchFleetUpdateStatus } from "@/runtime/runtime-config-query";
import type { RuntimeFleetUpdateStatusResponse } from "@/runtime/types";

export const FLEET_UPDATE_STATUS_POLL_INTERVAL_MS = 60 * 60 * 1000;
const FLEET_UPDATE_RESTART_POLL_INTERVAL_MS = 2_000;
const FLEET_UPDATE_RESTART_TIMEOUT_MS = 2 * 60 * 1000;

export type FleetUpdatePhase = "idle" | "applying" | "restarting" | "restart-timed-out";

interface UseFleetUpdateStatusResult {
	status: RuntimeFleetUpdateStatusResponse | null;
	phase: FleetUpdatePhase;
	apply: () => void;
}

/**
 * Polls the fleet CLI's vendor-build update status on an hourly cadence and
 * offers to apply it. Applying spawns `fleet update && fleet service restart`
 * server-side and cuts the current connection, so once the restart is under
 * way we switch to a fast poll until the server answers again, then reload
 * the page to pick up the new build.
 */
export function useFleetUpdateStatus(): UseFleetUpdateStatusResult {
	const [status, setStatus] = useState<RuntimeFleetUpdateStatusResponse | null>(null);
	const [phase, setPhase] = useState<FleetUpdatePhase>("idle");
	const phaseRef = useRef<FleetUpdatePhase>("idle");
	phaseRef.current = phase;

	useEffect(() => {
		let cancelled = false;

		async function checkOnce(): Promise<void> {
			if (phaseRef.current !== "idle") {
				return;
			}
			try {
				const nextStatus = await fetchFleetUpdateStatus(null);
				if (cancelled) {
					return;
				}
				setStatus(nextStatus);
			} catch {
				// Best-effort read; keep serving the last known status.
			}
		}

		void checkOnce();
		const interval = setInterval(() => {
			void checkOnce();
		}, FLEET_UPDATE_STATUS_POLL_INTERVAL_MS);

		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, []);

	useEffect(() => {
		if (phase !== "restarting") {
			return;
		}

		let cancelled = false;
		let hasSeenDown = false;
		const startedAt = Date.now();

		async function pollForRestart(): Promise<void> {
			try {
				await fetchFleetUpdateStatus(null);
				if (cancelled) {
					return;
				}
				if (hasSeenDown) {
					window.location.reload();
				}
			} catch {
				hasSeenDown = true;
				if (cancelled) {
					return;
				}
				if (Date.now() - startedAt > FLEET_UPDATE_RESTART_TIMEOUT_MS) {
					setPhase("restart-timed-out");
				}
			}
		}

		const interval = setInterval(() => {
			void pollForRestart();
		}, FLEET_UPDATE_RESTART_POLL_INTERVAL_MS);

		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [phase]);

	const apply = useCallback(() => {
		setPhase("applying");
		void (async () => {
			try {
				const result = await applyFleetUpdate(null);
				if (result.started) {
					setPhase("restarting");
					return;
				}
				setPhase("idle");
				try {
					const nextStatus = await fetchFleetUpdateStatus(null);
					setStatus(nextStatus);
				} catch {
					// Best-effort refresh; keep the previous status.
				}
			} catch {
				setPhase("idle");
			}
		})();
	}, []);

	return { status, phase, apply };
}
