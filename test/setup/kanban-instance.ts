import type { TestProject } from "vitest/node";

import { startIsolatedKanbanInstance } from "../utilities/kanban-test-instance";

/**
 * Vitest globalSetup: boot ONE isolated Kanban instance for the whole
 * integration run and tear it down after. Its base URL/port are exposed to
 * every test via `inject("kanbanBaseUrl")` / `inject("kanbanPort")`.
 *
 * The instance runs on a random port under a throwaway CLINE_HOME (see
 * startIsolatedKanbanInstance), so it can never touch a real/dogfood board.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
	const instance = await startIsolatedKanbanInstance();
	project.provide("kanbanBaseUrl", instance.baseUrl);
	project.provide("kanbanPort", instance.port);
	return async () => {
		await instance.stop();
	};
}

declare module "vitest" {
	export interface ProvidedContext {
		kanbanBaseUrl: string;
		kanbanPort: number;
	}
}
