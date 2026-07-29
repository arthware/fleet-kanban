import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getAvailablePort } from "../utilities/kanban-test-instance";

interface FleetProject {
	root: string;
	fleetDir: string;
	kanbanSource: string;
}

function createFleetProject(): FleetProject {
	const root = mkdtempSync(join(tmpdir(), "fleet-cli-liveness-"));
	const fleetDir = join(root, ".fleet");
	const kanbanSource = join(root, "kanban-source");
	const distDir = join(kanbanSource, "dist");
	mkdirSync(fleetDir);
	mkdirSync(distDir, { recursive: true });
	writeFileSync(join(fleetDir, "config.json"), JSON.stringify({ repos: [], kanban_port: 0 }));
	const fakeKanbanBin = join(distDir, "cli.js");
	writeFileSync(fakeKanbanBin, "#!/usr/bin/env bash\necho '{}'\n");
	chmodSync(fakeKanbanBin, 0o755);
	return { root, fleetDir, kanbanSource };
}

async function runFleet(input: {
	project: FleetProject;
	port: number;
	args: string[];
}): Promise<{ status: number | null; stdout: string; stderr: string }> {
	const child = spawn("bash", [join(process.cwd(), "fleet-cli/fleet"), ...input.args], {
		cwd: input.project.root,
		env: {
			...process.env,
			FLEET_DIR: input.project.fleetDir,
			KANBAN_SOURCE: input.project.kanbanSource,
			KANBAN_PORT: String(input.port),
			KANBAN_URL: `http://127.0.0.1:${input.port}`,
		},
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const status = await new Promise<number | null>((resolve) => {
		child.on("exit", (code) => resolve(code));
	});
	return { status, stdout, stderr };
}

async function startHttpServer(handler: RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
	const server = createServer(handler);
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, "127.0.0.1", () => resolveListen());
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	return {
		port,
		close: async () => {
			await new Promise<void>((resolveClose, rejectClose) => {
				server.close((error) => {
					if (error) {
						rejectClose(error);
						return;
					}
					resolveClose();
				});
			});
		},
	};
}

describe("fleet CLI kanban liveness gate", () => {
	const servers: Array<{ close: () => Promise<void> }> = [];

	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => server.close()));
	});

	it("given nothing is listening, when a task command requires the board, then it may tell the operator to start it", async () => {
		const project = createFleetProject();
		const port = await getAvailablePort();

		const result = await runFleet({ project, port, args: ["task", "ls"] });

		expect(result.status).toBe(1);
		const output = `${result.stdout}\n${result.stderr}`;
		expect(output).toContain("board not running");
		expect(output).toContain("fleet kanban start");
	});

	it("given a listener answers liveness with 500, when a task command requires the board, then it does not tell the operator to start another board", async () => {
		const project = createFleetProject();
		const server = await startHttpServer((_req, res) => {
			res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
			res.end('{"ok":false}');
		});
		servers.push(server);

		const result = await runFleet({ project, port: server.port, args: ["task", "ls"] });

		expect(result.status).toBe(1);
		const output = `${result.stdout}\n${result.stderr}`;
		expect(output).toContain("board answered but liveness failed");
		expect(output).not.toContain("fleet kanban start");
	});

	it("given an older board has no liveness endpoint, when status checks the board, then it falls back to projects.list", async () => {
		const project = createFleetProject();
		const server = await startHttpServer((req, res) => {
			if (req.url === "/api/healthz") {
				res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
				res.end('{"error":"Not found"}');
				return;
			}
			if (req.url === "/api/trpc/projects.list") {
				res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
				res.end('{"result":{"data":{"projects":[]}}}');
				return;
			}
			res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
			res.end('{"error":"Not found"}');
		});
		servers.push(server);

		const result = await runFleet({ project, port: server.port, args: ["kanban", "status"] });

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("kanban running");
		const output = `${result.stdout}\n${result.stderr}`;
		expect(output).not.toContain("fleet kanban start");
	});
});
