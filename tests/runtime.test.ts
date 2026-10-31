// Unit tests for the generated-server runtime (src/runtime), run directly
// against a local mock API.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { toToolSpec } from "../src/generator/index.js";
import { mapToMcpTools } from "../src/mapper/index.js";
import { parseSpec } from "../src/parser/index.js";
import { appendQuery, buildRequest, executeTool, formEncode } from "../src/runtime/http.js";
import type { ToolSpec } from "../src/runtime/types.js";
import { decodeJsonArgs, validateArgs } from "../src/runtime/validate.js";
import { WebhookStore, callWebhookTool, verifySignature } from "../src/runtime/webhooks.js";

interface Seen {
	method: string;
	url: URL;
	headers: Headers;
	body: string;
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
const seen: Seen[] = [];

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			seen.push({ method: req.method, url, headers: req.headers, body: await req.text() });
			if (url.pathname === "/stripe/items") {
				const after = url.searchParams.get("starting_after");
				const data = after ? [{ id: "c" }] : [{ id: "a" }, { id: "b" }];
				return Response.json({ object: "list", data, has_more: !after });
			}
			if (url.pathname === "/offset/items") {
				const offset = Number(url.searchParams.get("offset"));
				return Response.json({ results: offset >= 4 ? [] : [offset, offset + 1], total: 4 });
			}
			if (url.pathname === "/fail") return new Response("nope", { status: 404, statusText: "Not Found" });
			if (url.pathname === "/flaky") {
				const n = seen.filter((s) => s.url.pathname === "/flaky").length;
				return n < 2 ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } }) : Response.json({ ok: true });
			}
			if (url.pathname === "/sse") {
				return new Response("data: one\n\ndata: two\n\n", { headers: { "content-type": "text/event-stream" } });
			}
			return Response.json({ ok: true });
		},
	});
	base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

const opts = () => ({ baseUrl: base, auth: { mode: "none" as const } });

function tool(partial: Partial<ToolSpec>): ToolSpec {
	return {
		name: "t",
		description: "",
		inputSchema: { type: "object", properties: {} },
		method: "GET",
		path: "/",
		pathParams: [],
		queryParams: [],
		headerParams: [],
		bodyParams: [],
		bodyMode: "none",
		bodyContentType: "json",
		...partial,
	};
}

describe("validateArgs", () => {
	const schema = {
		type: "object",
		required: ["id"],
		properties: {
			id: { type: "integer" },
			flag: { type: "boolean" },
			tags: { type: "array", items: { type: "string" } },
			status: { type: "string", enum: ["open", "closed"] },
			meta: { type: "object", properties: { n: { type: "number" } } },
			maybe: { type: ["string", "null"] },
			either: { anyOf: [{ type: "integer" }, { type: "object", properties: { x: { type: "string" } } }] },
		},
	};

	test("coerces model-style values", () => {
		const r = validateArgs(schema, { id: "42", flag: "true", tags: "a,b", meta: '{"n": "1.5"}', maybe: null }, false);
		expect(r.errors).toEqual([]);
		expect(r.value).toEqual({ id: 42, flag: true, tags: ["a", "b"], meta: { n: 1.5 }, maybe: null });
	});

	test("reports precise errors", () => {
		const r = validateArgs(schema, { flag: "yes", status: "pending", bogus: 1 }, false);
		expect(r.errors.join("\n")).toContain("unknown argument(s): bogus");
		expect(r.errors.join("\n")).toContain("'id' is required");
		expect(r.errors.join("\n")).toContain("'flag' must be boolean");
		expect(r.errors.join("\n")).toContain('\'status\' must be one of: "open", "closed"');
	});

	test("anyOf accepts any matching variant", () => {
		expect(validateArgs(schema, { id: 1, either: 5 }, false).errors).toEqual([]);
		expect(validateArgs(schema, { id: 1, either: { x: "y" } }, false).errors).toEqual([]);
		expect(validateArgs(schema, { id: 1, either: true }, false).errors.length).toBe(1);
	});

	test("nullAsAbsent strips nulls (OpenAI strict optional fields)", () => {
		const r = validateArgs(schema, { id: 1, status: null, meta: { n: null } }, true);
		expect(r.errors).toEqual([]);
		expect(r.value).toEqual({ id: 1, meta: {} });
	});

	test("loose paths skip validation below collapsed unions", () => {
		const s = { type: "object", properties: { msgs: { type: "array", items: { type: "object", properties: { content: { type: "array", items: { type: "object" } } } } } } };
		const args = { msgs: [{ content: "plain text" }] };
		expect(validateArgs(s, args, false).errors.length).toBeGreaterThan(0);
		const r = validateArgs(s, args, false, ["msgs.*.content"]);
		expect(r.errors).toEqual([]);
		expect(r.value).toEqual(args);
	});

	test("decodeJsonArgs parses JSON-string fields at nested paths", () => {
		const out = decodeJsonArgs({ meta: '{"a":1}', list: ['{"b":2}', "plain"], keep: "{oops" }, ["meta", "list.*", "keep"]);
		expect(out).toEqual({ meta: { a: 1 }, list: [{ b: 2 }, "plain"], keep: "{oops" });
	});
});

describe("request building", () => {
	test("query serialization styles", () => {
		const p = new URLSearchParams();
		appendQuery(p, "expand", ["a", "b"]);
		appendQuery(p, "fields", ["x", "y"], "csv");
		appendQuery(p, "created", { gt: 1, lt: 5 }, "deep");
		appendQuery(p, "point", { lat: 1, lng: 2 }, "flat");
		appendQuery(p, "ids", [1, 2], "pipe");
		expect(decodeURIComponent(p.toString())).toBe(
			"expand=a&expand=b&fields=x,y&created[gt]=1&created[lt]=5&lat=1&lng=2&ids=1|2",
		);
	});

	test("form encoding uses bracket notation", () => {
		expect(decodeURIComponent(formEncode({ a: 1, meta: { k: "v" }, items: [{ p: "x" }] }).toString())).toBe(
			"a=1&meta[k]=v&items[0][p]=x",
		);
	});

	test("path, query, header and body params go to the right places", async () => {
		const t = tool({
			method: "POST",
			path: "/repos/{owner}/contents/{path}",
			pathParams: [
				["owner", "owner"],
				["path", "path"],
			],
			queryParams: [["filter_status", "filter[status]"]],
			headerParams: [["header_Notion-Version", "Notion-Version"]],
			bodyParams: [
				["name", "name"],
				["body_id", "id"],
			],
			bodyMode: "fields",
		});
		const { url, init } = await buildRequest(
			t,
			{ owner: "a b", path: "docs/readme.md", filter_status: "open", "header_Notion-Version": "2022-06-28", name: "n", body_id: 7 },
			opts(),
		);
		expect(url.pathname).toBe("/repos/a%20b/contents/docs/readme.md");
		expect(url.searchParams.get("filter[status]")).toBe("open");
		expect(init.headers["Notion-Version"]).toBe("2022-06-28");
		expect(JSON.parse(init.body as string)).toEqual({ name: "n", id: 7 });
		expect(init.headers["Content-Type"]).toBe("application/json");
	});

	test("GET requests carry no body or content type", async () => {
		const { init } = await buildRequest(tool({}), {}, opts());
		expect(init.body).toBeUndefined();
		expect(init.headers["Content-Type"]).toBeUndefined();
	});

	test("auth modes: api key in query, basic, and security: [] opt-out", async () => {
		await expect(
			buildRequest(tool({}), {}, { baseUrl: base, auth: { mode: "api-key", apiKeyName: "key", apiKeyIn: "query" } }),
		).rejects.toThrow("API_KEY environment variable is required");
		process.env.API_KEY = "secret";
		const q2 = await buildRequest(tool({}), {}, { baseUrl: base, auth: { mode: "api-key", apiKeyName: "key", apiKeyIn: "query" } });
		expect(q2.url.searchParams.get("key")).toBe("secret");
		process.env.API_USERNAME = "u";
		process.env.API_PASSWORD = "p";
		const b = await buildRequest(tool({}), {}, { baseUrl: base, auth: { mode: "basic" } });
		expect(b.init.headers.Authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
		delete process.env.API_KEY;
		const open = await buildRequest(tool({ requiresAuth: false }), {}, { baseUrl: base, auth: { mode: "bearer" } });
		expect(open.init.headers.Authorization).toBeUndefined();
	});

	test("per-operation server wins unless the base URL is forced", async () => {
		const t = tool({ baseUrl: "https://uploads.example.com" });
		expect((await buildRequest(t, {}, opts())).url.origin).toBe("https://uploads.example.com");
		expect((await buildRequest(t, {}, { ...opts(), useToolBaseUrls: false })).url.origin).toBe(base);
	});
});

describe("execution against a mock API", () => {
	test("HTTP errors are reported with isError and status", async () => {
		const r = await executeTool(tool({ path: "/fail" }), {}, opts());
		expect(r.isError).toBe(true);
		expect(r.content[0]).toMatchObject({ type: "text", text: "HTTP 404 Not Found\nnope" });
	});

	test("429 is retried using Retry-After", async () => {
		const r = await executeTool(tool({ path: "/flaky" }), {}, opts());
		expect(r.isError).toBeUndefined();
		expect(r.content[0]).toMatchObject({ text: '{"ok":true}' });
	});

	test("Stripe-style cursor pagination (has_more + last id)", async () => {
		const t = tool({
			path: "/stripe/items",
			pagination: { type: "cursor", limitParam: "limit", cursorParam: "starting_after", cursorPath: "", totalPath: "", itemsPath: "", defaultLimit: 2 },
		});
		const first = JSON.parse((await executeTool(t, {}, opts())).content[0].text as string);
		expect(first.items.map((i: { id: string }) => i.id)).toEqual(["a", "b"]);
		expect(first.has_more).toBe(true);
		const second = JSON.parse((await executeTool(t, { cursor: first.next_cursor }, opts())).content[0].text as string);
		expect(second.items).toEqual([{ id: "c" }]);
		expect(second.has_more).toBe(false);
		expect(seen.at(-1)!.url.searchParams.get("starting_after")).toBe("b");
	});

	test("offset pagination with auto-detected items and total", async () => {
		const t = tool({
			path: "/offset/items",
			pagination: { type: "offset", limitParam: "limit", offsetParam: "offset", cursorPath: "", totalPath: "", itemsPath: "", defaultLimit: 2 },
		});
		const first = JSON.parse((await executeTool(t, {}, opts())).content[0].text as string);
		expect(first).toMatchObject({ items: [0, 1], has_more: true, total: 4 });
		const second = JSON.parse((await executeTool(t, { cursor: first.next_cursor }, opts())).content[0].text as string);
		expect(second).toMatchObject({ items: [2, 3], has_more: false });
	});

	test("streaming tools send the body and collect the stream", async () => {
		const t = tool({ method: "POST", path: "/sse", streaming: true, bodyParams: [["prompt", "prompt"]], bodyMode: "fields" });
		const r = await executeTool(t, { prompt: "hi" }, opts());
		expect(r.content[0].text).toBe("data: one\n\ndata: two\n\n");
		expect(JSON.parse(seen.at(-1)!.body)).toEqual({ prompt: "hi" });
	});

	test("mapper output drives the runtime end to end (complex fixture)", async () => {
		const spec = await parseSpec(resolve(import.meta.dir, "fixtures/complex-api.yaml"));
		const tools = mapToMcpTools(spec).map((t) => toToolSpec(t) as unknown as ToolSpec);
		const charge = tools.find((t) => t.name === "createCharge")!;
		await executeTool(charge, { amount: 100, metadata: { order_id: "o1" } }, opts());
		const req = seen.at(-1)!;
		expect(req.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
		expect(decodeURIComponent(req.body)).toBe("amount=100&metadata[order_id]=o1");
	});
});

describe("webhooks", () => {
	test("store filters and long-polls", async () => {
		const store = new WebhookStore(10);
		store.add({ event: "issues.opened", route: "", received_at: "", headers: {}, payload: { n: 1 } });
		expect(store.list({ event: "issues" })).toHaveLength(1);
		const wait = store.wait({ event: "push", afterId: store.lastId }, 2000);
		setTimeout(() => store.add({ event: "push", route: "", received_at: "", headers: {}, payload: { ref: "main" } }), 20);
		const hit = await wait;
		expect(hit?.payload).toEqual({ ref: "main" });
		expect(await store.wait({ event: "never" }, 30)).toBeNull();
	});

	test("ring buffer drops oldest events", () => {
		const store = new WebhookStore(2);
		for (let i = 0; i < 5; i++) store.add({ event: "e", route: "", received_at: "", headers: {}, payload: i });
		expect(store.list({}).map((e) => e.payload)).toEqual([3, 4]);
		expect(store.lastId).toBe(5);
	});

	test("signature verification: GitHub, Stripe, Slack, generic", () => {
		const secret = "s3cret";
		const body = Buffer.from('{"a":1}');
		const hex = (data: string | Buffer) => createHmac("sha256", secret).update(data).digest("hex");
		expect(verifySignature(secret, body, { "x-hub-signature-256": `sha256=${hex(body)}` })).toBe(true);
		expect(verifySignature(secret, body, { "x-hub-signature-256": "sha256=00" })).toBe(false);
		expect(verifySignature(secret, body, { "stripe-signature": `t=1,v1=${hex(`1.${body}`)}` })).toBe(true);
		expect(
			verifySignature(secret, body, { "x-slack-signature": `v0=${hex(`v0:9:${body}`)}`, "x-slack-request-timestamp": "9" }),
		).toBe(true);
		expect(verifySignature(secret, body, { "x-signature": hex(body) })).toBe(true);
		expect(verifySignature(secret, body, {})).toBe(false);
	});

	test("wait tool times out cleanly and list tool shows receiver URLs", async () => {
		const store = new WebhookStore();
		const hooks = [{ name: "order.created", slug: "order-created", description: "", source: "webhook" as const, payloadFields: ["id"] }];
		const listed = JSON.parse((await callWebhookTool("webhooks_list_types", {}, store, hooks)).content[0].text as string);
		expect(listed.events[0].url).toEndWith("/webhooks/order-created");
		const waited = JSON.parse(
			(await callWebhookTool("webhooks_wait_for_event", { timeout_seconds: 1 }, store, hooks)).content[0].text as string,
		);
		expect(waited.timed_out).toBe(true);
	});
});
