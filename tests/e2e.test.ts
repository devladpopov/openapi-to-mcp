import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, CreateTaskResultSchema, GetTaskResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { generate } from "../src/generator/index.js";
import { detectAuth, extractWebhooks, mapToMcpTools } from "../src/mapper/index.js";
import { parseSpec } from "../src/parser/index.js";

// Full e2e: generate a server, install its real dependencies, compile it with
// tsc, then drive it with the official MCP client over stdio and Streamable
// HTTP against a local mock API. Catches what unit tests on generated files miss.

const fixture = resolve(import.meta.dir, "fixtures/e2e-api.yaml");
let outputDir: string;
let api: ReturnType<typeof Bun.serve>;
const requests: Array<{ method: string; url: URL; headers: Headers; body: string }> = [];

beforeAll(async () => {
	outputDir = mkdtempSync(join(tmpdir(), "openapi-to-mcp-e2e-"));
	const spec = await parseSpec(fixture);
	await generate({
		tools: mapToMcpTools(spec),
		spec,
		outputDir,
		serverName: "Orders",
		transport: "stdio",
		auth: detectAuth(spec),
		webhooks: extractWebhooks(spec),
	});
	api = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			requests.push({ method: req.method, url, headers: req.headers, body: await req.text() });
			if (url.pathname === "/v1/orders" && req.method === "GET") {
				const after = url.searchParams.get("starting_after");
				return Response.json({ data: after ? [{ id: "o3" }] : [{ id: "o1" }, { id: "o2" }], has_more: !after });
			}
			if (url.pathname === "/v1/orders" && req.method === "POST") return Response.json({ id: "o9" }, { status: 201 });
			if (url.pathname === "/v1/orders/missing") return Response.json({ error: "not found" }, { status: 404 });
			return Response.json({ ok: true });
		},
	});
});

afterAll(() => {
	api?.stop(true);
	if (!outputDir || !existsSync(outputDir)) return;
	// node_modules removal can exceed bun's 5s hook timeout on Windows,
	// so detach the cleanup instead of blocking the test run.
	if (process.platform === "win32") {
		spawn("cmd", ["/c", "rmdir", "/s", "/q", outputDir], { detached: true, stdio: "ignore" }).unref();
	} else {
		rmSync(outputDir, { recursive: true, force: true });
	}
});

function freePort(): Promise<number> {
	return new Promise((res) => {
		const srv = createServer();
		srv.listen(0, () => {
			const port = (srv.address() as { port: number }).port;
			srv.close(() => res(port));
		});
	});
}

function textOf(result: unknown): string {
	return ((result as { content: Array<{ text: string }> }).content[0]?.text ?? "") as string;
}

describe("e2e: generated server builds and serves MCP", () => {
	test(
		"bun install succeeds in generated project",
		() => {
			const result = spawnSync("bun", ["install", "--no-progress"], {
				cwd: outputDir,
				encoding: "utf-8",
				timeout: 120_000,
				shell: process.platform === "win32",
			});
			if (result.status !== 0) console.error(result.stdout, result.stderr);
			expect(result.status).toBe(0);
			expect(existsSync(join(outputDir, "node_modules"))).toBe(true);
		},
		130_000,
	);

	test(
		"tsc compiles the generated project",
		() => {
			// Use the tsc JS entry directly: bun on Windows does not create .cmd shims
			const tscJs = join(outputDir, "node_modules", "typescript", "lib", "tsc.js");
			const result = spawnSync("node", [tscJs], { cwd: outputDir, encoding: "utf-8", timeout: 120_000 });
			if (result.status !== 0) console.error(result.stdout, result.stderr);
			expect(result.status).toBe(0);
			expect(existsSync(join(outputDir, "dist", "server.js"))).toBe(true);
		},
		130_000,
	);

	test(
		"stdio: list tools, call API tools, validation errors, webhooks via MCP Tasks",
		async () => {
			const webhookPort = await freePort();
			const transport = new StdioClientTransport({
				command: "node",
				args: [join(outputDir, "dist", "server.js")],
				env: {
					...(process.env as Record<string, string>),
					API_BASE_URL: `http://localhost:${api.port}/v1`,
					API_TOKEN: "tok-123",
					WEBHOOK_PORT: String(webhookPort),
				},
				stderr: "pipe",
			});
			const client = new Client({ name: "e2e", version: "1.0.0" });
			await client.connect(transport);
			try {
				const { tools } = await client.listTools();
				const names = tools.map((t) => t.name);
				expect(names).toEqual(
					expect.arrayContaining(["listOrders", "createOrder", "getOrder", "health", "webhooks_wait_for_event"]),
				);
				const create = tools.find((t) => t.name === "createOrder")!;
				expect(Object.keys(create.inputSchema.properties ?? {})).toEqual(
					expect.arrayContaining(["Idempotency-Key", "sku", "quantity", "metadata", "note"]),
				);
				expect(create.inputSchema.required).toEqual(["Idempotency-Key", "sku", "quantity"]);
				expect(create.annotations?.readOnlyHint).toBe(false);
				const wait = tools.find((t) => t.name === "webhooks_wait_for_event")!;
				expect(wait.execution?.taskSupport).toBe("optional");

				// API call: header param, JSON body, bearer auth
				const created = await client.callTool({
					name: "createOrder",
					arguments: { "Idempotency-Key": "k1", sku: "A-1", quantity: "2", metadata: { gift: "yes" } },
				});
				expect(created.isError).toBeFalsy();
				expect(textOf(created)).toContain("o9");
				const post = requests.at(-1)!;
				expect(post.headers.get("authorization")).toBe("Bearer tok-123");
				expect(post.headers.get("idempotency-key")).toBe("k1");
				expect(JSON.parse(post.body)).toEqual({ sku: "A-1", quantity: 2, metadata: { gift: "yes" } });

				// Pagination with array query param serialization
				const page1 = JSON.parse(textOf(await client.callTool({ name: "listOrders", arguments: { status: ["open", "shipped"] } })));
				expect(page1.items).toHaveLength(2);
				expect(requests.at(-1)!.url.searchParams.getAll("status[]")).toEqual(["open", "shipped"]);
				const page2 = JSON.parse(textOf(await client.callTool({ name: "listOrders", arguments: { cursor: page1.next_cursor } })));
				expect(page2).toMatchObject({ items: [{ id: "o3" }], has_more: false });

				// Public operation (security: []) sends no credentials
				await client.callTool({ name: "health", arguments: {} });
				expect(requests.at(-1)!.headers.get("authorization")).toBeNull();

				// Errors come back as tool errors, not protocol failures
				const missing = await client.callTool({ name: "getOrder", arguments: { id: "missing" } });
				expect(missing.isError).toBe(true);
				expect(textOf(missing)).toContain("HTTP 404");
				const invalid = await client.callTool({ name: "createOrder", arguments: { sku: 5 } });
				expect(invalid.isError).toBe(true);
				expect(textOf(invalid)).toContain("'quantity' is required");

				// Webhook wait as an MCP Task: returns a task handle, completes when the event arrives
				const created_task = await client.request(
					{ method: "tools/call", params: { name: "webhooks_wait_for_event", arguments: { event: "order.created", timeout_seconds: 30 }, task: { ttl: 60_000 } } },
					CreateTaskResultSchema,
				);
				const taskId = created_task.task.taskId;
				expect(created_task.task.status).toBe("working");

				const delivered = await fetch(`http://127.0.0.1:${webhookPort}/webhooks/order-created`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ type: "order.created", data: { id: "o9" } }),
				});
				expect(delivered.status).toBe(200);

				let status = "working";
				for (let i = 0; i < 50 && status === "working"; i++) {
					await new Promise((r) => setTimeout(r, 100));
					status = (await client.request({ method: "tasks/get", params: { taskId } }, GetTaskResultSchema)).status;
				}
				expect(status).toBe("completed");
				const result = await client.request({ method: "tasks/result", params: { taskId } }, CallToolResultSchema);
				const event = JSON.parse(textOf(result)).event;
				expect(event).toMatchObject({ event: "order.created", payload: { data: { id: "o9" } } });

				// The same event is visible through polling
				const polled = JSON.parse(textOf(await client.callTool({ name: "webhooks_get_events", arguments: {} })));
				expect(polled.events).toHaveLength(1);
			} finally {
				await client.close();
			}
		},
		60_000,
	);

	test(
		"streamable-http: stateless server answers multiple clients",
		async () => {
			const port = await freePort();
			const child = spawn("node", [join(outputDir, "dist", "server.js")], {
				env: { ...process.env, MCP_TRANSPORT: "streamable-http", PORT: String(port), API_BASE_URL: `http://localhost:${api.port}/v1`, API_TOKEN: "t" },
				stdio: ["ignore", "ignore", "pipe"],
			});
			try {
				await new Promise<void>((res, rej) => {
					const timer = setTimeout(() => rej(new Error("server did not start")), 15_000);
					child.stderr!.on("data", (d: Buffer) => {
						if (d.toString().includes("listening")) {
							clearTimeout(timer);
							res();
						}
					});
				});
				for (let i = 0; i < 2; i++) {
					const client = new Client({ name: `http-${i}`, version: "1.0.0" });
					await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
					const { tools } = await client.listTools();
					expect(tools.length).toBeGreaterThan(4);
					const r = await client.callTool({ name: "getOrder", arguments: { id: "o1" } });
					expect(r.isError).toBeFalsy();
					await client.close();
				}
				const health = await fetch(`http://localhost:${port}/health`);
				expect((await health.json()).ok).toBe(true);
			} finally {
				child.kill();
			}
		},
		60_000,
	);
});
