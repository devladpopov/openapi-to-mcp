// Semantic check of generator output on real-world specs (downloaded on
// demand into .cache/specs, see scripts/specs.ts). For every spec and client target it
// verifies the provider schema rules from src/schema/adapt.ts, compiles every
// input schema with ajv, and dry-runs the runtime request builder with
// synthesized arguments for every tool.
//
//   bun scripts/check-specs.ts [name...]

import Ajv from "ajv";
import { toToolSpec } from "../src/generator/index.js";
import { detectAuth, extractWebhooks, mapToMcpTools } from "../src/mapper/index.js";
import { parseSpec } from "../src/parser/index.js";
import { buildRequest } from "../src/runtime/http.js";
import type { ToolSpec } from "../src/runtime/types.js";
import { decodeJsonArgs, validateArgs } from "../src/runtime/validate.js";
import { ensureSpecs } from "./specs.js";
import { CLIENT_TARGETS, type ClientTarget, type JsonSchema, type McpToolDefinition } from "../src/types.js";

const files = await ensureSpecs(process.argv.slice(2));

process.env.API_KEY = "k";
process.env.API_TOKEN = "t";
process.env.API_USERNAME = "u";
process.env.API_PASSWORD = "p";
process.env.OAUTH_ACCESS_TOKEN = "x";

const KEY_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const ajv = new Ajv({ strict: false, allErrors: false, validateSchema: true, logger: false });

type Violations = Map<string, string[]>;
function flag(v: Violations, rule: string, detail: string) {
	const list = v.get(rule) ?? [];
	if (list.length < 3) list.push(detail);
	v.set(rule, list);
	(v as Violations & { counts?: Map<string, number> }).counts ??= new Map();
	const counts = (v as Violations & { counts: Map<string, number> }).counts;
	counts.set(rule, (counts.get(rule) ?? 0) + 1);
}

function walk(s: JsonSchema, fn: (node: JsonSchema, path: string) => void, path = ""): void {
	if (!s || typeof s !== "object") return;
	fn(s, path);
	for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, fn, `${path}.${k}`);
	if (s.items) walk(s.items, fn, `${path}[]`);
	for (const v of s.anyOf ?? []) walk(v, fn, `${path}|`);
	for (const v of s.oneOf ?? []) walk(v, fn, `${path}|`);
	if (s.additionalProperties && typeof s.additionalProperties === "object") walk(s.additionalProperties, fn, `${path}{}`);
}

const typesOf = (n: JsonSchema) => (n.type === undefined ? [] : Array.isArray(n.type) ? n.type : [n.type]);

function checkTarget(target: ClientTarget, tools: McpToolDefinition[], serverName: string, v: Violations) {
	const seen = new Set<string>();
	for (const t of tools) {
		const id = t.name;
		if (!NAME_RE.test(t.name)) flag(v, "name.pattern", id);
		if (seen.has(t.name)) flag(v, "name.duplicate", id);
		seen.add(t.name);
		if (t.inputSchema.type !== "object") flag(v, "schema.rootNotObject", id);
		for (const k of Object.keys(t.inputSchema.properties ?? {})) if (!KEY_RE.test(k)) flag(v, "schema.topKey", `${id}.${k}`);
		try {
			ajv.compile(t.inputSchema);
		} catch (err) {
			flag(v, "schema.ajvInvalid", `${id}: ${(err as Error).message.slice(0, 120)}`);
		}
		const slug = serverName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
		if ((target === "cursor" || target === "portable") && slug.length + 1 + t.name.length > Math.max(60, slug.length + 25)) {
			flag(v, "name.cursorBudget", id);
		}
		if ((target === "gemini" || target === "portable") && !/^[a-zA-Z_]/.test(t.name)) flag(v, "name.geminiStart", id);
		if ((target === "openai" || target === "portable") && t.description.length > 1024) flag(v, "desc.openai1024", id);

		walk(t.inputSchema, (n, p) => {
			const where = `${id}${p}`;
			const types = typesOf(n);
			if (target === "openai") {
				if (n.oneOf || n.allOf) flag(v, "openai.oneOf/allOf", where);
				if (types.includes("object")) {
					if (n.additionalProperties !== false) flag(v, "openai.additionalProperties", where);
					const keys = Object.keys(n.properties ?? {});
					if ((n.required ?? []).length !== keys.length) flag(v, "openai.allRequired", where);
					if (keys.length === 0 && p) flag(v, "openai.emptyObject", where);
				}
				if (types.includes("array") && (!n.items || (!n.items.type && !n.items.anyOf))) flag(v, "openai.arrayItems", where);
				if ("default" in n || "minLength" in n || "maxLength" in n) flag(v, "openai.unsupportedKeyword", where);
			}
			if (target === "gemini" || target === "portable") {
				if (n.anyOf || n.oneOf || n.allOf) flag(v, "gemini.union", where);
				if (n.additionalProperties !== undefined) flag(v, "gemini.additionalProperties", where);
				if ("const" in n) flag(v, "gemini.const", where);
				if (Array.isArray(n.type)) flag(v, "gemini.typeArray", where);
				if (n.enum && n.enum.some((x) => typeof x !== "string")) flag(v, "gemini.nonStringEnum", where);
				if (p && types.length === 0) flag(v, "gemini.untyped", where);
				if (types.includes("object") && Object.keys(n.properties ?? {}).length === 0 && p) flag(v, "gemini.emptyObject", where);
				if (types.includes("array") && !n.items?.type) flag(v, "gemini.arrayItems", where);
			}
			if (target === "bedrock" && (n.anyOf || n.oneOf || n.allOf)) flag(v, "bedrock.union", where);
		});
	}
}

/** Minimal arguments satisfying `required`, to exercise the runtime request builder. */
function sample(s: JsonSchema, depth = 0): unknown {
	if (s.anyOf?.length) return sample(s.anyOf[0], depth);
	if (s.enum?.length) return s.enum.find((x) => x !== null) ?? s.enum[0];
	const t = typesOf(s).find((x) => x !== "null");
	if (t === "integer" || t === "number") return typeof s.minimum === "number" ? s.minimum : 1;
	if (t === "boolean") return true;
	if (t === "array") return s.items && depth < 12 ? [sample(s.items, depth + 1)] : [];
	if (t === "object" || s.properties) {
		const out: Record<string, unknown> = {};
		if (depth < 12) for (const k of s.required ?? []) if (s.properties?.[k]) out[k] = sample(s.properties[k], depth + 1);
		return out;
	}
	if (t === "string") {
		if (s.format === "date-time") return "2024-01-01T00:00:00Z";
		if (s.format === "date") return "2024-01-01";
		if (typeof s.minLength === "number" && s.minLength > 1) return "x".repeat(s.minLength);
		return "x";
	}
	return "x";
}

async function runtimeSmoke(tools: McpToolDefinition[], authMode: ReturnType<typeof detectAuth>, v: Violations) {
	for (const def of tools) {
		const tool = toToolSpec(def) as unknown as ToolSpec;
		const args = sample(def.inputSchema) as Record<string, unknown>;
		const { value, errors } = validateArgs(tool.inputSchema, args, false);
		if (errors.length) {
			flag(v, "runtime.sampleRejected", `${def.name}: ${errors[0]}`);
			continue;
		}
		try {
			const { url } = await buildRequest(tool, decodeJsonArgs(value, tool.jsonArgs), {
				baseUrl: "https://api.example.test/v1",
				auth: { mode: authMode.startsWith("oauth2") ? "bearer" : authMode, apiKeyName: "X-Key" },
			});
			if (/[{}]/.test(decodeURIComponent(url.pathname))) flag(v, "runtime.unfilledPath", `${def.name}: ${url.pathname}`);
		} catch (err) {
			flag(v, "runtime.buildRequestThrew", `${def.name}: ${(err as Error).message}`);
		}
	}
}

const rows: string[] = [];
let totalViolations = 0;
for (const { name, file } of files) {
	const t0 = performance.now();
	let spec;
	try {
		spec = await parseSpec(file);
	} catch (err) {
		rows.push(`| ${name} | PARSE FAIL: ${(err as Error).message} |`);
		continue;
	}
	const parseMs = performance.now() - t0;
	const auth = detectAuth(spec);
	const webhooks = extractWebhooks(spec);
	const v: Violations = new Map();
	let toolCount = 0;
	let listBytes = 0;
	let maxSchema = 0;
	let mapMs = 0;
	for (const target of CLIENT_TARGETS) {
		const t1 = performance.now();
		const tools = mapToMcpTools(spec, { target, serverName: spec.info.title });
		mapMs = Math.max(mapMs, performance.now() - t1);
		if (target === "generic") {
			toolCount = tools.length;
			listBytes = JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))).length;
			maxSchema = Math.max(...tools.map((t) => JSON.stringify(t.inputSchema).length), 0);
			await runtimeSmoke(tools, auth, v);
		}
		checkTarget(target, tools, spec.info.title, v);
	}
	const counts = (v as Violations & { counts?: Map<string, number> }).counts ?? new Map();
	const n = [...counts.values()].reduce((a, b) => a + b, 0);
	totalViolations += n;
	rows.push(
		`| ${name} | ${spec.openapi} | ${toolCount} | ${webhooks.length} | ${auth} | ${(listBytes / 1024).toFixed(0)}KB | ${(maxSchema / 1024).toFixed(1)}KB | ${parseMs.toFixed(0)}ms / ${mapMs.toFixed(0)}ms | ${n === 0 ? "ok" : [...counts].map(([r, c]) => `${r}:${c}`).join(", ")} |`,
	);
	for (const [rule, examples] of v) console.error(`  [${name}] ${rule}: ${examples.join(" ; ")}`);
}

console.log("| spec | version | tools | webhooks | auth | tools/list | max schema | parse / map | violations |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of rows) console.log(r);
console.log(`\nTotal violations: ${totalViolations}`);
process.exit(totalViolations > 0 ? 1 : 0);
