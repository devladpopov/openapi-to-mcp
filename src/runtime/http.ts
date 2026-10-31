// Turns validated tool arguments into an HTTP request and the response into
// MCP tool content. Every generated tool goes through executeTool().

import { applyAuth } from "./auth.js";
import type { AuthConfig, PaginationSpec, ToolResult, ToolSpec } from "./types.js";

export interface HttpOptions {
	baseUrl: string;
	auth: AuthConfig;
	signal?: AbortSignal;
	/** Honour per-operation servers (false when the user forced API_BASE_URL). */
	useToolBaseUrls?: boolean;
}

const TIMEOUT_MS = Number.parseInt(process.env.API_TIMEOUT_MS ?? "30000", 10);
const STREAM_TIMEOUT_MS = Number.parseInt(process.env.STREAM_TIMEOUT_MS ?? "120000", 10);
const MAX_RESPONSE_CHARS = Number.parseInt(process.env.MAX_RESPONSE_CHARS ?? "100000", 10);
const MAX_RETRIES = Number.parseInt(process.env.API_MAX_RETRIES ?? "2", 10);

export async function executeTool(tool: ToolSpec, args: Record<string, unknown>, opts: HttpOptions): Promise<ToolResult> {
	if (tool.pagination) return executePaginated(tool, tool.pagination, args, opts);
	const req = await buildRequest(tool, args, opts);
	if (tool.streaming) return executeStreaming(req, opts);
	const res = await send(req, opts, TIMEOUT_MS);
	return formatResponse(res);
}

interface BuiltRequest {
	url: URL;
	init: RequestInit & { headers: Record<string, string> };
}

export async function buildRequest(
	tool: ToolSpec,
	args: Record<string, unknown>,
	opts: HttpOptions,
	extraQuery: Record<string, string> = {},
): Promise<BuiltRequest> {
	let path = tool.path;
	for (const [prop, wire] of tool.pathParams) {
		const v = args[prop];
		if (v === undefined || v === null || v === "") throw new Error(`Missing required path parameter '${prop}'`);
		const raw = String(v);
		let encoded = encodeURIComponent(raw);
		// File-path style parameters (GitHub contents/{path}) keep their slashes.
		const keepSlashes = /path$/i.test(wire);
		if (keepSlashes) encoded = encoded.replace(/%2F/gi, "/");
		// "." / ".." segments would be resolved by URL parsing and reach other endpoints.
		const segments = keepSlashes ? raw.split("/") : [raw];
		if (segments.some((s) => s === "." || s === "..")) {
			throw new Error(`Invalid value for path parameter '${prop}': relative segments are not allowed`);
		}
		path = path.split(`{${wire}}`).join(encoded);
	}
	const base = ((opts.useToolBaseUrls !== false && tool.baseUrl) || opts.baseUrl).replace(/\/+$/, "");
	if (!base) throw new Error("API_BASE_URL is not set: configure it in the MCP server environment");
	const url = new URL(base + path);

	for (const [prop, wire] of tool.queryParams) {
		appendQuery(url.searchParams, wire, args[prop], tool.queryStyles?.[wire]);
	}
	for (const [k, v] of Object.entries(extraQuery)) url.searchParams.set(k, v);

	const headers: Record<string, string> = { Accept: tool.streaming ? "text/event-stream" : "application/json, */*;q=0.8" };
	const extra = process.env.API_EXTRA_HEADERS;
	if (extra) {
		try {
			Object.assign(headers, JSON.parse(extra));
		} catch {
			throw new Error("API_EXTRA_HEADERS must be a JSON object");
		}
	}
	for (const [prop, wire] of tool.headerParams) {
		const v = args[prop];
		if (v !== undefined && v !== null) headers[wire] = typeof v === "object" ? JSON.stringify(v) : String(v);
	}

	const init: BuiltRequest["init"] = { method: tool.method, headers };
	if (tool.bodyMode !== "none" && tool.method !== "GET" && tool.method !== "HEAD") {
		const payload = pickBody(args, tool.bodyParams);
		if (payload !== undefined) {
			const body = encodeBody(tool, payload);
			init.body = body.body;
			if (body.contentType) headers["Content-Type"] = body.contentType;
		}
	}

	if (tool.requiresAuth !== false) await applyAuth(opts.auth, { headers, url });
	return { url, init };
}

const DELIMITERS = { csv: ",", ssv: " ", pipe: "|" } as const;

export function appendQuery(params: URLSearchParams, name: string, value: unknown, style?: string): void {
	if (value === undefined || value === null) return;
	if (style === "csv" || style === "ssv" || style === "pipe") {
		const parts = Array.isArray(value)
			? value
			: typeof value === "object"
				? Object.entries(value as Record<string, unknown>).flat()
				: [value];
		params.append(name, parts.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(DELIMITERS[style]));
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) appendQuery(params, name, item, style === "deep" ? "deep" : undefined);
		return;
	}
	if (typeof value === "object") {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			// flat (form, explode): b=c; otherwise deepObject: a[b]=c
			if (style === "flat") appendQuery(params, k, v);
			else appendQuery(params, `${name}[${k}]`, v, "deep");
		}
		return;
	}
	params.append(name, String(value));
}

function pickBody(args: Record<string, unknown>, pairs: ToolSpec["bodyParams"]): unknown {
	if (pairs.length === 1 && pairs[0][1] === "*") return args[pairs[0][0]];
	const out: Record<string, unknown> = {};
	let any = false;
	for (const [prop, field] of pairs) {
		if (args[prop] !== undefined) {
			out[field] = args[prop];
			any = true;
		}
	}
	return any || pairs.length > 0 ? out : undefined;
}

function encodeBody(tool: ToolSpec, payload: unknown): { body: NonNullable<RequestInit["body"]>; contentType?: string } {
	switch (tool.bodyContentType) {
		case "form":
			return { body: formEncode(payload).toString(), contentType: "application/x-www-form-urlencoded" };
		case "multipart": {
			const form = new FormData();
			for (const [k, v] of Object.entries((payload ?? {}) as Record<string, unknown>)) {
				if (v === undefined || v === null) continue;
				if (typeof v === "string" && v.startsWith("base64:")) {
					form.append(k, new Blob([Buffer.from(v.slice(7), "base64")]), k);
				} else {
					form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
				}
			}
			// fetch sets the multipart boundary itself.
			return { body: form };
		}
		case "text":
			return { body: String(payload ?? ""), contentType: tool.bodyMediaType ?? "text/plain" };
		case "binary": {
			const s = String(payload ?? "");
			const body = s.startsWith("base64:") ? Buffer.from(s.slice(7), "base64") : s;
			return { body: body as NonNullable<RequestInit["body"]>, contentType: tool.bodyMediaType ?? "application/octet-stream" };
		}
		default:
			return { body: JSON.stringify(payload), contentType: tool.bodyMediaType ?? "application/json" };
	}
}

/** Bracket notation (a[b][0]=c), as used by Stripe and Rails-style APIs. */
export function formEncode(value: unknown, prefix = "", out = new URLSearchParams()): URLSearchParams {
	if (value === null || value === undefined) return out;
	if (typeof value === "object") {
		if (Array.isArray(value)) {
			value.forEach((v, i) => {
				formEncode(v, prefix ? `${prefix}[${i}]` : String(i), out);
			});
		} else {
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				formEncode(v, prefix ? `${prefix}[${k}]` : k, out);
			}
		}
	} else if (prefix) {
		out.append(prefix, String(value));
	}
	return out;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * fetch with manual redirects: fetch only strips Authorization and Cookie on
 * cross-origin redirects, so API keys in custom headers or the query string
 * would leak to e.g. a CDN. Cross-origin hops are followed without credentials.
 */
async function fetchFollowing(req: BuiltRequest, signal: AbortSignal): Promise<Response> {
	let url = req.url;
	let method = req.init.method ?? "GET";
	let body = req.init.body;
	let headers = { ...(req.init.headers as Record<string, string>) };
	for (let hop = 0; hop < 5; hop++) {
		const res = await fetch(url, { method, body, headers, redirect: "manual", signal });
		const location = res.headers.get("location");
		if (!REDIRECTS.has(res.status) || !location) return res;
		await res.body?.cancel();
		const next = new URL(location, url);
		if (next.origin !== req.url.origin) {
			const kept: Record<string, string> = { Accept: headers.Accept ?? "*/*" };
			if (headers["Content-Type"]) kept["Content-Type"] = headers["Content-Type"];
			headers = kept;
		}
		if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
			method = "GET";
			body = undefined;
			const { "Content-Type": _ct, ...rest } = headers;
			headers = rest;
		}
		url = next;
	}
	throw new Error("Too many redirects");
}

async function send(req: BuiltRequest, opts: HttpOptions, timeoutMs: number): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const signals = [AbortSignal.timeout(timeoutMs)];
		if (opts.signal) signals.push(opts.signal);
		const res = await fetchFollowing(req, AbortSignal.any(signals));
		if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES && retryable(req.init.body)) {
			const wait = retryDelayMs(res.headers.get("retry-after"), attempt);
			if (wait !== null) {
				await res.body?.cancel();
				await new Promise((r) => setTimeout(r, wait));
				continue;
			}
		}
		return res;
	}
}

function retryable(body: unknown): boolean {
	// FormData and buffers are fine to resend; streams would not be.
	return !(body instanceof ReadableStream);
}

function retryDelayMs(header: string | null, attempt: number): number | null {
	const fallback = 1000 * 2 ** attempt;
	if (!header) return fallback;
	const seconds = Number(header);
	const ms = Number.isNaN(seconds) ? new Date(header).getTime() - Date.now() : seconds * 1000;
	if (Number.isNaN(ms)) return fallback;
	return ms <= 10_000 ? Math.max(0, ms) : null;
}

export async function formatResponse(res: Response): Promise<ToolResult> {
	const contentType = res.headers.get("content-type") ?? "";
	if (res.ok && contentType.startsWith("image/")) {
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.length <= 5 * 1024 * 1024) {
			return { content: [{ type: "image", data: buf.toString("base64"), mimeType: contentType.split(";")[0] }] };
		}
		return { content: [{ type: "text", text: `Binary ${contentType} response (${buf.length} bytes) not shown` }] };
	}
	const raw = await res.text();
	let text = raw;
	if (!raw) text = `HTTP ${res.status} ${res.statusText} (empty body)`;
	text = clip(text);
	if (!res.ok) {
		return { isError: true, content: [{ type: "text", text: `HTTP ${res.status} ${res.statusText}\n${text}` }] };
	}
	return { content: [{ type: "text", text }] };
}

function clip(text: string): string {
	if (text.length <= MAX_RESPONSE_CHARS) return text;
	return `${text.slice(0, MAX_RESPONSE_CHARS)}\n... [truncated ${text.length - MAX_RESPONSE_CHARS} characters; narrow the request with filters or a smaller page size]`;
}

async function executeStreaming(req: BuiltRequest, opts: HttpOptions): Promise<ToolResult> {
	const res = await send(req, opts, STREAM_TIMEOUT_MS);
	if (!res.ok || !res.body) return formatResponse(res);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (text.length < MAX_RESPONSE_CHARS) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
	} catch (err) {
		if (!text) throw err;
		text += `\n[stream interrupted: ${(err as Error).message}]`;
	} finally {
		reader.cancel().catch(() => {});
	}
	return { content: [{ type: "text", text: clip(text) }] };
}

// --- Pagination ----------------------------------------------------------

const ITEM_KEYS = ["data", "items", "results", "records", "entries", "values", "objects", "list", "content", "nodes", "elements"];
const TOTAL_KEYS = ["total", "total_count", "totalCount", "total_results", "totalResults", "totalItems", "meta.total", "pagination.total"];
const CURSOR_KEYS = [
	"next_cursor",
	"nextCursor",
	"next_page_token",
	"nextPageToken",
	"next_token",
	"nextToken",
	"response_metadata.next_cursor",
	"meta.next_cursor",
	"meta.nextCursor",
	"pagination.next_cursor",
	"pagination.nextCursor",
	"paging.next.after",
	"paging.cursors.after",
	"cursor.next",
	"links.next",
	"next",
];

function encodeCursor(data: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(data)).toString("base64url");
}

function decodeCursor(cursor: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
		if (parsed && typeof parsed === "object") return parsed;
	} catch {
		// fall through
	}
	// Accept a raw API cursor too (e.g. copied from a previous raw response).
	return { cursor };
}

function getPath(obj: unknown, path: string): unknown {
	let cur = obj;
	for (const seg of path.split(".")) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

function firstPath(obj: unknown, explicit: string, candidates: string[]): unknown {
	if (explicit) return getPath(obj, explicit);
	for (const c of candidates) {
		const v = getPath(obj, c);
		if (v !== undefined && v !== null && v !== "") return v;
	}
	return undefined;
}

function extractItems(parsed: unknown, itemsPath: string): unknown[] | null {
	if (Array.isArray(parsed)) return parsed;
	const explicit = itemsPath ? getPath(parsed, itemsPath) : undefined;
	if (Array.isArray(explicit)) return explicit;
	if (!parsed || typeof parsed !== "object") return null;
	for (const k of ITEM_KEYS) {
		const v = (parsed as Record<string, unknown>)[k];
		if (Array.isArray(v)) return v;
	}
	// Fall back to the only array-valued property, if there is exactly one.
	const arrays = Object.values(parsed as Record<string, unknown>).filter(Array.isArray);
	return arrays.length === 1 ? (arrays[0] as unknown[]) : null;
}

async function executePaginated(
	tool: ToolSpec,
	pg: PaginationSpec,
	args: Record<string, unknown>,
	opts: HttpOptions,
): Promise<ToolResult> {
	const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : pg.defaultLimit;
	const state = typeof args.cursor === "string" && args.cursor ? decodeCursor(args.cursor) : {};
	const extra: Record<string, string> = { [pg.limitParam]: String(limit) };
	let offset = 0;
	let page = 1;
	if (pg.type === "offset") {
		offset = Number(state.offset ?? 0) || 0;
		extra[pg.offsetParam ?? "offset"] = String(offset);
	} else if (pg.type === "page") {
		page = Number(state.page ?? 1) || 1;
		extra[pg.pageParam ?? "page"] = String(page);
	} else if (typeof state.cursor === "string") {
		extra[pg.cursorParam ?? "cursor"] = state.cursor;
	}

	const req = await buildRequest(tool, args, opts, extra);
	const res = await send(req, opts, TIMEOUT_MS);
	if (!res.ok) return formatResponse(res);
	const raw = await res.text();
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { content: [{ type: "text", text: clip(raw) }] };
	}
	const items = extractItems(parsed, pg.itemsPath);
	if (!items) return { content: [{ type: "text", text: clip(raw) }] };

	const totalRaw = firstPath(parsed, pg.totalPath, TOTAL_KEYS);
	const total = typeof totalRaw === "number" ? totalRaw : undefined;
	const linkNext = /<[^>]+>;\s*rel="next"/.test(res.headers.get("link") ?? "");
	const explicitHasMore = typeof getPath(parsed, "has_more") === "boolean" ? (getPath(parsed, "has_more") as boolean) : undefined;

	let nextCursor: string | null = null;
	if (pg.type === "offset") {
		const next = offset + items.length;
		const more = explicitHasMore ?? (total !== undefined ? next < total : linkNext || items.length >= limit);
		if (more && items.length > 0) nextCursor = encodeCursor({ offset: next });
	} else if (pg.type === "page") {
		const more =
			explicitHasMore ?? (total !== undefined ? page * limit < total : linkNext || items.length >= limit);
		if (more && items.length > 0) nextCursor = encodeCursor({ page: page + 1 });
	} else {
		let apiCursor = firstPath(parsed, pg.cursorPath, CURSOR_KEYS);
		if (typeof apiCursor === "string" && /^https?:\/\//.test(apiCursor)) {
			// Some APIs return the next page URL; extract the cursor parameter from it.
			try {
				apiCursor = new URL(apiCursor).searchParams.get(pg.cursorParam ?? "cursor") ?? undefined;
			} catch {
				apiCursor = undefined;
			}
		}
		if ((apiCursor === undefined || apiCursor === null) && explicitHasMore && items.length > 0) {
			// Stripe-style: has_more + starting_after=<last item id>
			const last = items[items.length - 1] as Record<string, unknown> | null;
			if (last && typeof last === "object" && last.id !== undefined) apiCursor = String(last.id);
		}
		if (typeof apiCursor === "string" || typeof apiCursor === "number") {
			if (explicitHasMore !== false && String(apiCursor) !== "") nextCursor = encodeCursor({ cursor: String(apiCursor) });
		}
	}

	const result: Record<string, unknown> = { items, has_more: nextCursor !== null };
	if (nextCursor) result.next_cursor = nextCursor;
	if (total !== undefined) result.total = total;
	return { content: [{ type: "text", text: clip(JSON.stringify(result, null, 2)) }] };
}
