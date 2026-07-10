import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "./vitest.config";

/**
 * Integration test config: like the base config, but boots ONE shared Kanban
 * instance for the whole run (globalSetup) that tests reach via
 * `inject("kanbanBaseUrl")`. Used by `npm run test:integration`.
 */
export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["test/integration/**/*.integration.test.ts"],
			globalSetup: ["./test/setup/kanban-instance.ts"],
			testTimeout: 30_000,
		},
	}),
);
