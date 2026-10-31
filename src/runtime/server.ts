// MCP server entry point. Tool definitions live in ../tools.json (generated
// from the OpenAPI spec; safe to edit by hand), settings in ./config.ts.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListResourcesRequestSchema,
	ListTasksRequestSchema,
	ListToolsRequestSchema,
	McpError,
	ReadResourceRequestSchema,
	SubscribeRequestSchema,
	UnsubscribeRequestSchema,
	type CallToolResult,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { CONFIG } from "./config.js";
import { executeTool } from "./http.js";
import type { ToolResult, ToolSpec, ToolsFile } from "./types.js";
import { decodeJsonArgs, validateArgs } from "./validate.js";
import {
	WEBHOOK_TOOL_NAMES,
	WebhookStore,
	callWebhookTool,
	handleWebhookRequest,
	startWebhookServer,
	webhookToolSpecs,
} from "./webhooks.js";

const toolsFile = JSON.parse(
	readFileSync(process.env.MCP_TOOLS_FILE ?? new URL("../tools.json", import.meta.url), "utf-8"),
) as ToolsFile;
const webhooks = process.env.WEBHOOKS_DISABLED === "true" ? [] : (toolsFile.webhooks ?? []);
const webhookStore = new WebhookStore();
const API_BASE_URL = process.env.API_BASE_URL ?? CONFIG.baseUrl;

const apiTools = toolsFile.tools.filter(isEnabled);
const allTools: ToolSpec[] = [...apiTools, ...(webhooks.length > 0 ? webhookToolSpecs(webhooks) : [])];
const toolsByName = new Map(allTools.map((t) => [t.name, t]));

/** Long-running tools that advertise MCP Tasks support (call now, fetch result later). */
function supportsTasks(tool: ToolSpec): boolean {
	if (process.env.MCP_TASKS === "off") return false;
	if (process.env.MCP_TASKS === "all") return true;
	return tool.name === "webhooks_wait_for_event" || tool.streaming === true;
}

async function callTool(tool: ToolSpec, rawArgs: unknown, signal?: AbortSignal): Promise<CallToolResult> {
	const { value, errors } = validateArgs(tool.inputSchema, rawArgs, CONFIG.nullAsAbsent, tool.looseArgs);
	if (errors.length > 0) {
		return errorResult(`Invalid arguments for ${tool.name}:\n- ${errors.join("\n- ")}`);
	}
	const args = decodeJsonArgs(value, tool.jsonArgs, tool.jsonAnyArgs);
	try {
		let result: ToolResult;
		if (WEBHOOK_TOOL_NAMES.includes(tool.name) && !tool.method) {
			result = await callWebhookTool(tool.name, args, webhookStore, webhooks, signal);
		} else {
			result = await executeTool(tool, args, {
				baseUrl: API_BASE_URL,
				auth: CONFIG.auth,
				signal,
				useToolBaseUrls: !process.env.API_BASE_URL || process.env.API_BASE_URL === CONFIG.baseUrl,
			});
		}
		return result as CallToolResult;
	} catch (err) {
		return errorResult(`${tool.method} ${tool.path} failed: ${messageOf(err)}`);
	}
}

function errorResult(text: string): CallToolResult {
	return { isError: true, content: [{ type: "text", text }] };
}

function messageOf(err: unknown): string {
	if (err instanceof Error) {
		const cause = (err as Error & { cause?: unknown }).cause;
		return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
	}
	return String(err);
}

/** MCP_TOOLS_INCLUDE / MCP_TOOLS_EXCLUDE: comma-separated names, tags or globs. MCP_READ_ONLY=true: GET only. */
function isEnabled(tool: ToolSpec): boolean {
	if (process.env.MCP_READ_ONLY === "true" && tool.method !== "GET") return false;
	const include = patterns(process.env.MCP_TOOLS_INCLUDE);
	const exclude = patterns(process.env.MCP_TOOLS_EXCLUDE);
	const keys = [tool.name, ...(tool.tags ?? [])];
	if (include.length && !include.some((re) => keys.some((k) => re.test(k)))) return false;
	if (exclude.some((re) => keys.some((k) => re.test(k)))) return false;
	return true;
}

function patterns(env: string | undefined): RegExp[] {
	if (!env) return [];
	return env
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i"));
}

const EVENTS_URI = "webhook://events";
const taskStore = new InMemoryTaskStore();

/**
 * Run a task-augmented call in the background. The task outlives the request
 * (and, over stateless HTTP, the server instance that created it), so results
 * go straight to the shared store, and the work is aborted when the client
 * cancels the task or its TTL expires.
 */
function runTask(taskId: string, tool: ToolSpec, args: unknown): void {
	const controller = new AbortController();
	const watcher = setInterval(async () => {
		const current = await taskStore.getTask(taskId).catch(() => null);
		if (!current || current.status === "cancelled") controller.abort();
	}, 1000);
	watcher.unref();
	callTool(tool, args, controller.signal)
		.then(async (result) => {
			if (controller.signal.aborted) return;
			await taskStore.storeTaskResult(taskId, result.isError ? "failed" : "completed", result);
		})
		.catch(async (err) => {
			if (controller.signal.aborted) return;
			await taskStore.storeTaskResult(taskId, "failed", errorResult(messageOf(err)));
		})
		.catch(() => {
			// Task already finished, cancelled or expired: nothing left to report.
		})
		.finally(() => clearInterval(watcher));
}

/** One MCP server per connection (stdio) or per request (stateless Streamable HTTP). */
function createMcpServer(shared: boolean): Server {
	const server = new Server(
		{ name: CONFIG.serverName, version: CONFIG.serverVersion },
		{
			capabilities: {
				tools: {},
				// Over shared HTTP every client sees one store; listing would expose
				// other callers' tasks, so only unguessable task ids give access.
				tasks: { ...(shared ? {} : { list: {} }), cancel: {}, requests: { tools: { call: {} } } },
				...(webhooks.length > 0 ? { resources: { subscribe: true } } : {}),
			},
			taskStore,
		},
	);

	if (shared) {
		server.setRequestHandler(ListTasksRequestSchema, async () => {
			throw new McpError(ErrorCode.MethodNotFound, "tasks/list is disabled on shared HTTP servers");
		});
	}

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: allTools.map((t): Tool => {
			const tool: Tool = {
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema as Tool["inputSchema"],
			};
			if (t.title) tool.title = t.title;
			if (t.annotations) tool.annotations = t.annotations;
			if (supportsTasks(t)) tool.execution = { taskSupport: "optional" };
			return tool;
		}),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		const tool = toolsByName.get(request.params.name);
		if (!tool) {
			return errorResult(`Unknown tool '${request.params.name}'. Use tools/list to see available tools.`);
		}
		const run = () => callTool(tool, request.params.arguments, extra.signal);

		if (request.params.task && extra.taskStore && supportsTasks(tool)) {
			const task = await extra.taskStore.createTask({
				ttl: request.params.task.ttl ?? 60 * 60 * 1000,
				pollInterval: 2000,
			});
			runTask(task.taskId, tool, request.params.arguments);
			return { task };
		}
		return run();
	});

	// Webhook events as a subscribable resource.
	const subscriptions = new Set<string>();
	if (webhooks.length > 0) {
		server.setRequestHandler(ListResourcesRequestSchema, async () => ({
			resources: [
				{
					uri: EVENTS_URI,
					name: "Webhook events",
					description: "The most recent webhook events received by this server (newest last).",
					mimeType: "application/json",
				},
			],
		}));
		server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
			if (request.params.uri !== EVENTS_URI) throw new Error(`Unknown resource ${request.params.uri}`);
			const events = webhookStore.list({ afterId: Math.max(0, webhookStore.lastId - 50) }, 50);
			return { contents: [{ uri: EVENTS_URI, mimeType: "application/json", text: JSON.stringify(events, null, 2) }] };
		});
		server.setRequestHandler(SubscribeRequestSchema, async (request) => {
			subscriptions.add(request.params.uri);
			return {};
		});
		server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
			subscriptions.delete(request.params.uri);
			return {};
		});
		const unsubscribe = webhookStore.onEvent(() => {
			if (subscriptions.has(EVENTS_URI)) server.sendResourceUpdated({ uri: EVENTS_URI }).catch(() => {});
		});
		server.onclose = unsubscribe;
	}
	return server;
}

// --- Transport ------------------------------------------------------------

async function main() {
	const transport = process.env.MCP_TRANSPORT ?? CONFIG.transport;
	if (transport === "stdio") {
		if (webhooks.length > 0) startWebhookServer(webhookStore, webhooks);
		await createMcpServer(false).connect(new StdioServerTransport());
		return;
	}

	// Streamable HTTP, stateless (no session ids): a fresh server + transport per request.
	const port = Number.parseInt(process.env.PORT ?? "3000", 10);
	// The server holds API credentials: bind to loopback unless told otherwise,
	// and reject foreign Host/Origin headers (DNS rebinding from a web page).
	const host = process.env.HOST ?? "127.0.0.1";
	const authToken = process.env.MCP_AUTH_TOKEN;
	const allowedHosts = new Set(
		["localhost", "127.0.0.1", "[::1]", ...(process.env.MCP_ALLOWED_HOSTS ?? "").split(",")]
			.map((h) => h.trim().toLowerCase())
			.filter(Boolean),
	);
	const loopbackOnly = !process.env.MCP_ALLOWED_HOSTS && ["127.0.0.1", "localhost", "::1"].includes(host);
	if (!loopbackOnly && !authToken) {
		console.error("Warning: MCP endpoint is reachable from the network without MCP_AUTH_TOKEN");
	}
	if (webhooks.length > 0 && !process.env.WEBHOOK_SECRET) {
		console.error("Warning: WEBHOOK_SECRET is not set, webhook signatures are not verified");
	}
	const hostAllowed = (value: string | undefined) => {
		if (!value) return false;
		try {
			return allowedHosts.has(new URL(`http://${value}`).hostname.toLowerCase());
		} catch {
			return false;
		}
	};

	const httpServer = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		try {
			if (url.pathname === "/mcp") {
				const origin = req.headers.origin;
				if (loopbackOnly && (!hostAllowed(req.headers.host) || (origin && !hostAllowed(origin.replace(/^\w+:\/\//, ""))))) {
					res.writeHead(403);
					res.end("Forbidden host");
					return;
				}
				if (authToken && req.headers.authorization !== `Bearer ${authToken}`) {
					res.writeHead(401, { "WWW-Authenticate": "Bearer" });
					res.end("Unauthorized");
					return;
				}
				const server = createMcpServer(true);
				const http = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
				res.on("close", () => {
					http.close().catch(() => {});
					server.close().catch(() => {});
				});
				await server.connect(http);
				await http.handleRequest(req, res);
			} else if (url.pathname === "/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, tools: allTools.length }));
			} else if (!(webhooks.length > 0 && (await handleWebhookRequest(req, res, webhookStore, webhooks)))) {
				res.writeHead(404);
				res.end("Not found");
			}
		} catch (err) {
			console.error("Error handling request:", err);
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
			}
		}
	});
	httpServer.listen(port, host, () => {
		console.error(`MCP server listening on http://${host.includes(":") ? `[${host}]` : host}:${port}/mcp`);
		if (webhooks.length > 0) console.error(`Webhook receiver at http://localhost:${port}/webhooks`);
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
