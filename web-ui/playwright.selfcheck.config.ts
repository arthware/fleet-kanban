import { defineConfig } from "@playwright/test";

const baseURL = process.env.KANBAN_SELFCHECK_BASE_URL;
if (!baseURL) {
	throw new Error("KANBAN_SELFCHECK_BASE_URL is required.");
}

export default defineConfig({
	testDir: "./tests",
	timeout: 45_000,
	outputDir: process.env.KANBAN_SELFCHECK_ARTIFACT_DIR,
	use: {
		baseURL,
		headless: true,
		screenshot: "only-on-failure",
		trace: "retain-on-failure",
	},
});
