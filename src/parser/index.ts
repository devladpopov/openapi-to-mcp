import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { OpenApiSpec } from "../types.js";
import { resolveRefs } from "./refs.js";

export async function parseSpec(input: string): Promise<OpenApiSpec> {
	const raw = await loadRaw(input);
	const spec = deserialize(raw, input);

	validateSpec(spec);

	return resolveRefs(spec);
}

async function loadRaw(input: string): Promise<string> {
	if (input.startsWith("http://") || input.startsWith("https://")) {
		const res = await fetch(input);
		if (!res.ok) {
			throw new Error(`Failed to fetch spec from ${input}: ${res.status} ${res.statusText}`);
		}
		return res.text();
	}
	return readFileSync(input, "utf-8");
}

function deserialize(raw: string, source: string): OpenApiSpec {
	const ext = extname(source).toLowerCase();
	if (ext === ".json") {
		return JSON.parse(raw);
	}
	// Default to YAML for .yaml, .yml, or URLs
	return parseYaml(raw) as OpenApiSpec;
}

function validateSpec(spec: unknown): asserts spec is OpenApiSpec {
	const s = spec as Record<string, unknown>;
	if (!s.openapi || typeof s.openapi !== "string") {
		throw new Error("Invalid spec: missing 'openapi' version field");
	}
	if (!s.openapi.startsWith("3.")) {
		throw new Error(`Unsupported OpenAPI version: ${s.openapi}. Only 3.x is supported.`);
	}
	if (!s.paths || typeof s.paths !== "object") {
		throw new Error("Invalid spec: missing 'paths' object");
	}
	if (!s.info || typeof s.info !== "object") {
		throw new Error("Invalid spec: missing 'info' object");
	}
}
