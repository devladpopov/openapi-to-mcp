// Webhooks for MCP: MCP has no server-initiated tool calls, so incoming events
// are received over HTTP, buffered, and handed to the model through tools:
//
//   webhooks_list_types      what events exist and where to point the provider
//   webhooks_get_events      poll buffered events
//   webhooks_wait_for_event  long-poll; supports MCP Tasks (call now, fetch later)
//
// Clients that subscribe to the webhook://events resource also get
// notifications/resources/updated when a new event arrives.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { ToolResult, ToolSpec, WebhookSpec } from "./types.js";

export interface WebhookEvent {
	id: number;
	event: string;
	route: string;
	received_at: string;
	headers: Record<string, string>;
	payload: unknown;
}

type Filter = { event?: string; afterId?: number; match?: string };

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const FORWARDED_HEADERS = [
	"content-type",
	"user-agent",
	"x-github-event",
	"x-github-delivery",
	"x-event-type",
	"x-webhook-event",
	"x-request-id",
	"stripe-signature",
	"x-slack-request-timestamp",
];

export class WebhookStore {
	private events: WebhookEvent[] = [];
	private nextId = 1;
	private waiters = new Set<() => void>();
	private listeners = new Set<(e: WebhookEvent) => void>();

	constructor(private readonly capacity = Number.parseInt(process.env.WEBHOOK_BUFFER_SIZE ?? "500", 10)) {}

	get lastId(): number {
		return this.nextId - 1;
	}

	add(event: Omit<WebhookEvent, "id">): WebhookEvent {
		const full = { id: this.nextId++, ...event };
		this.events.push(full);
		if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
		for (const wake of this.waiters) wake();
		for (const l of this.listeners) l(full);
		return full;
	}

	/** Returns an unsubscribe function. */
	onEvent(listener: (e: WebhookEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	list(filter: Filter, limit = 50): WebhookEvent[] {
		return this.events.filter((e) => matches(e, filter)).slice(0, limit);
	}

	async wait(filter: Filter, timeoutMs: number, signal?: AbortSignal): Promise<WebhookEvent | null> {
		const found = this.list(filter, 1)[0];
		if (found) return found;
		return new Promise((resolve) => {
			const done = (e: WebhookEvent | null) => {
				clearTimeout(timer);
				this.waiters.delete(check);
				signal?.removeEventListener("abort", onAbort);
				resolve(e);
			};
			const check = () => {
				const hit = this.list(filter, 1)[0];
				if (hit) done(hit);
			};
			const onAbort = () => done(null);
			const timer = setTimeout(() => done(null), timeoutMs);
			this.waiters.add(check);
			signal?.addEventListener("abort", onAbort);
		});
	}
}

function matches(e: WebhookEvent, f: Filter): boolean {
	if (f.afterId !== undefined && e.id <= f.afterId) return false;
	if (f.event && e.event !== f.event && e.route !== f.event && !e.event.startsWith(`${f.event}.`)) return false;
	if (f.match && !JSON.stringify(e.payload).toLowerCase().includes(f.match.toLowerCase())) return false;
	return true;
}

// --- HTTP receiver ---------------------------------------------------------

export function webhookBaseUrl(): string {
	if (process.env.WEBHOOK_PUBLIC_URL) return process.env.WEBHOOK_PUBLIC_URL.replace(/\/+$/, "");
	const port = process.env.WEBHOOK_PORT ?? "8787";
	return `http://localhost:${port}/webhooks`;
}

/**
 * Handle POST /webhooks[/<slug>]. Returns false when the request is not a
 * webhook so the caller can route it elsewhere (shared HTTP server mode).
 */
export async function handleWebhookRequest(
	req: IncomingMessage,
	res: ServerResponse,
	store: WebhookStore,
	webhooks: WebhookSpec[],
): Promise<boolean> {
	const url = new URL(req.url ?? "/", "http://localhost");
	const match = url.pathname.match(/^\/webhooks(?:\/([^/]+))?\/?$/);
	if (!match) return false;
	if (req.method !== "POST") {
		res.writeHead(405, { Allow: "POST" });
		res.end();
		return true;
	}
	let raw: Buffer;
	try {
		raw = await readBody(req);
	} catch {
		res.writeHead(413);
		res.end("Payload too large");
		return true;
	}
	const headers = lowerHeaders(req);
	const secret = process.env.WEBHOOK_SECRET;
	if (secret && !verifySignature(secret, raw, headers)) {
		res.writeHead(401);
		res.end("Invalid signature");
		return true;
	}

	const text = raw.toString("utf-8");
	let payload: unknown = text;
	const ct = headers["content-type"] ?? "";
	if (ct.includes("json") || /^\s*[[{]/.test(text)) {
		try {
			payload = JSON.parse(text);
		} catch {
			// keep raw text
		}
	} else if (ct.includes("application/x-www-form-urlencoded")) {
		const form = Object.fromEntries(new URLSearchParams(text));
		// Slack interactivity and some legacy providers wrap JSON in a "payload" field.
		payload = typeof form.payload === "string" ? (safeJson(form.payload) ?? form) : form;
	}

	// Slack Events API handshake.
	const p = payload as Record<string, unknown> | null;
	if (p && typeof p === "object" && p.type === "url_verification" && typeof p.challenge === "string") {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end(p.challenge);
		return true;
	}

	const slug = match[1] ? decodeURIComponent(match[1]) : "";
	const known = webhooks.find((w) => w.slug === slug || w.name === slug);
	const event = known?.name ?? detectEventName(headers, payload) ?? (slug || "unknown");
	const forwarded: Record<string, string> = {};
	for (const h of FORWARDED_HEADERS) if (headers[h]) forwarded[h] = headers[h];
	const stored = store.add({ event, route: slug, received_at: new Date().toISOString(), headers: forwarded, payload });

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ ok: true, id: stored.id }));
	return true;
}

export function startWebhookServer(store: WebhookStore, webhooks: WebhookSpec[]): HttpServer {
	const port = Number.parseInt(process.env.WEBHOOK_PORT ?? "8787", 10);
	const host = process.env.WEBHOOK_HOST ?? "127.0.0.1";
	const srv = createServer(async (req, res) => {
		try {
			if (!(await handleWebhookRequest(req, res, store, webhooks))) {
				res.writeHead(404);
				res.end("Not found");
			}
		} catch (err) {
			console.error("Webhook error:", err);
			if (!res.headersSent) res.writeHead(500);
			res.end();
		}
	});
	srv.on("error", (err: NodeJS.ErrnoException) => {
		// Never take the MCP server down because the webhook port is busy.
		console.error(`Webhook receiver disabled (${err.code ?? err.message}) on ${host}:${port}`);
	});
	srv.listen(port, host, () => console.error(`Webhook receiver listening on http://${host}:${port}/webhooks`));
	return srv;
}

function detectEventName(headers: Record<string, string>, payload: unknown): string | null {
	const fromHeader = headers["x-github-event"] ?? headers["x-event-type"] ?? headers["x-webhook-event"] ?? headers["x-event-key"];
	if (fromHeader) {
		const action = (payload as Record<string, unknown> | null)?.action;
		return typeof action === "string" ? `${fromHeader}.${action}` : fromHeader;
	}
	const p = payload as Record<string, unknown> | null;
	if (!p || typeof p !== "object") return null;
	for (const key of ["type", "event", "event_type", "eventType", "topic"]) {
		if (typeof p[key] === "string") return p[key] as string;
	}
	const inner = p.event as Record<string, unknown> | undefined;
	if (inner && typeof inner === "object" && typeof inner.type === "string") return inner.type;
	return null;
}

/** HMAC-SHA256 in the formats used by GitHub, Stripe, Slack and generic providers. */
export function verifySignature(secret: string, raw: Buffer, headers: Record<string, string>): boolean {
	const hmac = (data: Buffer | string) => createHmac("sha256", secret).update(data).digest();
	const eqHex = (expected: Buffer, hex: string) => safeEqual(expected, Buffer.from(hex.trim(), "hex"));

	const gh = headers["x-hub-signature-256"];
	if (gh) return gh.startsWith("sha256=") && eqHex(hmac(raw), gh.slice(7));

	const stripe = headers["stripe-signature"];
	if (stripe) {
		const parts = Object.fromEntries(stripe.split(",").map((kv) => kv.split("=") as [string, string]));
		const sigs = stripe
			.split(",")
			.filter((kv) => kv.startsWith("v1="))
			.map((kv) => kv.slice(3));
		if (!parts.t) return false;
		const expected = hmac(`${parts.t}.${raw.toString("utf-8")}`);
		return sigs.some((s) => eqHex(expected, s));
	}

	const slack = headers["x-slack-signature"];
	if (slack) {
		const ts = headers["x-slack-request-timestamp"] ?? "";
		return slack.startsWith("v0=") && eqHex(hmac(`v0:${ts}:${raw.toString("utf-8")}`), slack.slice(3));
	}

	const generic = headers[(process.env.WEBHOOK_SIGNATURE_HEADER ?? "x-signature").toLowerCase()] ?? headers["x-webhook-signature"];
	if (generic) {
		const value = generic.replace(/^sha256=/, "");
		const expected = hmac(raw);
		return eqHex(expected, value) || safeEqual(expected, Buffer.from(value, "base64"));
	}
	return false;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
	return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function lowerHeaders(req: IncomingMessage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
	}
	return out;
}

function safeJson(s: string): unknown {
	try {
		return JSON.parse(s);
	} catch {
		return undefined;
	}
}

// --- MCP tools -------------------------------------------------------------

export const WEBHOOK_TOOL_NAMES = ["webhooks_list_types", "webhooks_get_events", "webhooks_wait_for_event"];

/** Tool definitions in the same shape as API tools, so they share listing code. */
export function webhookToolSpecs(webhooks: WebhookSpec[]): ToolSpec[] {
	const names = webhooks.map((w) => w.name);
	const eventProp = {
		type: "string",
		description: names.length
			? `Event name to filter by, e.g. ${names.slice(0, 8).map((n) => JSON.stringify(n)).join(", ")}${names.length > 8 ? ", ..." : ""}. Omit for all events.`
			: "Event name to filter by. Omit for all events.",
	};
	const base = {
		method: "",
		path: "",
		pathParams: [],
		queryParams: [],
		headerParams: [],
		bodyParams: [],
		bodyMode: "none" as const,
		bodyContentType: "json" as const,
	};
	return [
		{
			...base,
			name: "webhooks_list_types",
			description:
				"List the webhook events this API can send, and the receiver URL to register with the provider. Call this first to see which events can be waited on.",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		{
			...base,
			name: "webhooks_get_events",
			description:
				"Return webhook events received so far (oldest first). Pass after_id from a previous call to get only newer events.",
			inputSchema: {
				type: "object",
				properties: {
					event: eventProp,
					after_id: { type: "integer", description: "Only return events with id greater than this." },
					match: { type: "string", description: "Only events whose payload contains this text (case-insensitive)." },
					limit: { type: "integer", description: "Maximum events to return (default 20, max 100)." },
				},
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		{
			...base,
			name: "webhooks_wait_for_event",
			description:
				"Wait until a matching webhook event arrives and return it. By default only events received after this call count. Supports MCP Tasks: task-aware clients get a task handle immediately and fetch the result later.",
			inputSchema: {
				type: "object",
				properties: {
					event: eventProp,
					match: { type: "string", description: "Only events whose payload contains this text (case-insensitive)." },
					after_id: {
						type: "integer",
						description: "Accept events with id greater than this (default: the latest id at call time).",
					},
					timeout_seconds: { type: "integer", description: "How long to wait (default 60, max 3600)." },
				},
			},
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
	];
}

export async function callWebhookTool(
	name: string,
	args: Record<string, unknown>,
	store: WebhookStore,
	webhooks: WebhookSpec[],
	signal?: AbortSignal,
): Promise<ToolResult> {
	const text = (v: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(v, null, 2) }] });
	const event = typeof args.event === "string" && args.event ? args.event : undefined;
	const match = typeof args.match === "string" && args.match ? args.match : undefined;

	if (name === "webhooks_list_types") {
		const base = webhookBaseUrl();
		return text({
			receiver: base,
			hint: "Register the receiver URL with the API provider (use a tunnel such as ngrok or cloudflared for local servers). Per-event URLs route events by name.",
			events: webhooks.map((w) => ({
				name: w.name,
				url: `${base}/${w.slug}`,
				description: w.description,
				source: w.source === "callback" ? `callback registered by ${w.operation}` : "webhook",
				payload_fields: w.payloadFields,
			})),
			received_so_far: store.lastId,
		});
	}
	if (name === "webhooks_get_events") {
		const afterId = typeof args.after_id === "number" ? args.after_id : undefined;
		const limit = Math.min(100, typeof args.limit === "number" && args.limit > 0 ? args.limit : 20);
		const events = store.list({ event, afterId, match }, limit);
		return text({ events, last_id: events.length ? events[events.length - 1].id : (afterId ?? store.lastId) });
	}
	// webhooks_wait_for_event
	const afterId = typeof args.after_id === "number" ? args.after_id : store.lastId;
	const seconds = Math.min(3600, Math.max(1, typeof args.timeout_seconds === "number" ? args.timeout_seconds : 60));
	const hit = await store.wait({ event, afterId, match }, seconds * 1000, signal);
	if (!hit) {
		return text({ timed_out: true, waited_seconds: seconds, last_id: store.lastId, hint: "Call again to keep waiting." });
	}
	return text({ event: hit });
}
