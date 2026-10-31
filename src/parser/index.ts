import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { OpenApiSpec } from "../types.js";
import { resolveRefs } from "./refs.js";
import { convertSwagger2 } from "./swagger2.js";

export async function parseSpec(input: string): Promise<OpenApiSpec> {
	const raw = await loadRaw(input);
	let spec = deserialize(raw, input) as unknown;

	if (isSwagger2(spec)) {
		spec = convertSwagger2(spec as Record<string, unknown>);
	}
	validateSpec(spec);

	const resolved = resolveRefs(spec);
	normalizeServers(resolved, input);
	return resolved;
}

async function loadRaw(input: string): Promise<string> {
	if (isUrl(input)) {
		const res = await fetch(input);
		if (!res.ok) {
			throw new Error(`Failed to fetch spec from ${input}: ${res.status} ${res.statusText}`);
		}
		return res.text();
	}
	return readFileSync(input, "utf-8");
}

function isUrl(input: string): boolean {
	return input.startsWith("http://") || input.startsWith("https://");
}

function deserialize(raw: string, source: string): unknown {
	const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
	const ext = extname(source.split("?")[0]).toLowerCase();
	if (ext === ".json" || text.trimStart().startsWith("{")) {
		try {
			return JSON.parse(text);
		} catch (err) {
			if (ext === ".json") throw new Error(`Invalid JSON in ${source}: ${(err as Error).message}`);
		}
	}
	// YAML is a JSON superset, so this also covers JSON served without an extension.
	return parseYaml(text, { maxAliasCount: -1, uniqueKeys: false });
}

function isSwagger2(spec: unknown): boolean {
	const s = spec as Record<string, unknown> | null;
	return !!s && typeof s === "object" && typeof s.swagger === "string" && s.swagger.startsWith("2.");
}

function validateSpec(spec: unknown): asserts spec is OpenApiSpec {
	if (!spec || typeof spec !== "object") {
		throw new Error("Invalid spec: expected a YAML or JSON object");
	}
	const s = spec as Record<string, unknown>;
	if (!s.openapi || typeof s.openapi !== "string") {
		throw new Error("Invalid spec: missing 'openapi' version field");
	}
	if (!s.openapi.startsWith("3.")) {
		throw new Error(`Unsupported OpenAPI version: ${s.openapi}. Only 3.x (and Swagger 2.0) are supported.`);
	}
	if (!s.info || typeof s.info !== "object") {
		throw new Error("Invalid spec: missing 'info' object");
	}
	// 3.1 allows webhook-only documents without paths.
	if (s.paths === undefined || s.paths === null) {
		if (!s.webhooks) throw new Error("Invalid spec: missing 'paths' object");
		s.paths = {};
	} else if (typeof s.paths !== "object") {
		throw new Error("Invalid spec: 'paths' must be an object");
	}
}

/**
 * Make server URLs directly usable as API_BASE_URL defaults: substitute
 * server variables with their defaults and resolve relative URLs against the
 * URL the spec was fetched from (e.g. petstore3 declares "/api/v3").
 */
function normalizeServers(spec: OpenApiSpec, source: string): void {
	const lists = [spec.servers];
	for (const item of Object.values(spec.paths ?? {})) {
		if (!item || typeof item !== "object") continue;
		lists.push(item.servers);
		for (const op of Object.values(item)) {
			if (op && typeof op === "object" && "servers" in op) lists.push((op as { servers?: OpenApiSpec["servers"] }).servers);
		}
	}
	for (const list of lists) if (Array.isArray(list)) normalizeServerList(list, source);
}

function normalizeServerList(servers: NonNullable<OpenApiSpec["servers"]>, source: string): void {
	for (const server of servers) {
		if (!server || typeof server.url !== "string") continue;
		let url = server.url.replace(/\{([^}]+)\}/g, (m, name: string) => {
			const v = server.variables?.[name];
			return v?.default !== undefined ? String(v.default) : m;
		});
		if (isUrl(source) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
			try {
				url = new URL(url || "/", source).toString();
			} catch {
				// keep as-is
			}
		}
		server.url = url.replace(/\/+$/, "");
	}
}
