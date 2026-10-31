// Lenient JSON Schema validation for tool arguments.
//
// Models often send "5" for an integer, a JSON string for an object, or a
// single value for an array. Those are coerced instead of rejected; anything
// that cannot be coerced is reported back with the exact path so the model can
// fix its next call. Values that already match a declared type or union
// variant are never coerced.

import type { JsonSchema } from "./types.js";

export interface ValidationResult {
	value: Record<string, unknown>;
	errors: string[];
}

/**
 * Paths in jsonArgs / looseArgs are dot-separated with "*" for array items;
 * literal dots and percent signs inside keys are escaped as %2E / %25.
 */
export function pathSegment(key: string): string {
	return key.replace(/%/g, "%25").replace(/\./g, "%2E");
}

function splitPath(path: string): string[] {
	return path.split(".").map((s) => (s === "*" ? s : s.replace(/%2E/g, ".").replace(/%25/g, "%")));
}

export function validateArgs(
	schema: JsonSchema,
	args: unknown,
	nullAsAbsent: boolean,
	loosePaths: string[] = [],
): ValidationResult {
	const errors: string[] = [];
	const loose = new Set(loosePaths);
	let input = args;
	if (input === undefined || input === null) input = {};
	if (typeof input === "string") input = tryParseJson(input) ?? input;
	if (typeof input !== "object" || Array.isArray(input)) {
		return { value: {}, errors: ["arguments must be an object"] };
	}
	const obj = { ...(input as Record<string, unknown>) };

	const props = schema.properties ?? {};
	const unknown = Object.keys(obj).filter((k) => !(k in props));
	if (unknown.length > 0) {
		errors.push(`unknown argument(s): ${unknown.join(", ")}. Valid arguments: ${Object.keys(props).join(", ") || "(none)"}`);
	}
	let value = check(schema, obj, "", "", errors, { loose, nullAsAbsent }, false) as Record<string, unknown>;
	// OpenAI strict mode marks every field required and sends null for the ones
	// the model leaves empty; those mean "omitted" for the API. Stripped after
	// validation so the required check sees them.
	if (nullAsAbsent) value = stripNulls(value) as Record<string, unknown>;
	return { value, errors };
}

/**
 * `path` is for messages (a.b[0]); `pattern` matches loose paths (a.b.*).
 * `exact`: only accept values whose JS type already matches (no coercion) at
 * this node; used to pick the right union variant before coercing.
 */
function check(
	schema: JsonSchema | undefined,
	value: unknown,
	path: string,
	pattern: string,
	errors: string[],
	ctx: { loose: Set<string>; nullAsAbsent: boolean },
	exact: boolean,
): unknown {
	if (!schema || typeof schema !== "object") return value;
	if (pattern && ctx.loose.has(pattern)) return value;

	if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
		for (const strict of [true, false]) {
			for (const variant of schema.anyOf) {
				const attempt: string[] = [];
				const result = check(variant, value, path, pattern, attempt, ctx, strict);
				if (attempt.length === 0) return result;
			}
		}
		errors.push(`${label(path)} does not match any of the allowed shapes`);
		return value;
	}

	const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
	if (value === null) {
		if (types.length === 0 || types.includes("null")) return null;
		if (ctx.nullAsAbsent) return undefined;
		errors.push(`${label(path)} must not be null`);
		return value;
	}
	if (types.length === 0) return value;

	const concrete = types.filter((t) => t !== "null");
	let out: unknown = value;
	let matched = concrete.find((t) => matchesExactly(t, value)) !== undefined;
	if (!matched && !exact) {
		for (const type of concrete) {
			const r = coerce(type, value);
			if (r.ok) {
				out = r.value;
				matched = true;
				break;
			}
		}
	}
	if (!matched) {
		errors.push(`${label(path)} must be ${concrete.join(" or ")}, got ${describe(value)}`);
		return value;
	}

	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		const allowed = schema.enum;
		const hit = allowed.find((v) => v === out || (!exact && v !== null && String(v) === String(out)));
		if (hit === undefined) {
			const list = allowed.slice(0, 25).map((v) => JSON.stringify(v)).join(", ");
			errors.push(`${label(path)} must be one of: ${list}${allowed.length > 25 ? ", ..." : ""}`);
		} else {
			out = hit;
		}
	}

	if (out && typeof out === "object" && !Array.isArray(out)) {
		const obj = out as Record<string, unknown>;
		const props = schema.properties ?? {};
		for (const key of schema.required ?? []) {
			// With nullAsAbsent, null on a field that does not allow it means "omitted".
			const missing = obj[key] === undefined || (obj[key] === null && ctx.nullAsAbsent && !allowsNull(props[key]));
			if (missing) errors.push(`${label(join(path, key))} is required`);
		}
		const result: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(obj)) {
			if (v === undefined) continue;
			const checked = props[key]
				? check(props[key], v, join(path, key), join(pattern, pathSegment(key)), errors, ctx, false)
				: v;
			if (checked !== undefined) result[key] = checked;
		}
		return result;
	}
	if (Array.isArray(out) && schema.items) {
		return out.map((item, i) => check(schema.items, item, `${path}[${i}]`, join(pattern, "*"), errors, ctx, false));
	}
	return out;
}

function allowsNull(schema: JsonSchema | undefined): boolean {
	if (!schema) return true;
	if (schema.type === undefined && !schema.anyOf) return true;
	if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
	return !!schema.anyOf?.some((v) => v.type === "null" || (Array.isArray(v.type) && v.type.includes("null")));
}

function matchesExactly(type: string, value: unknown): boolean {
	switch (type) {
		case "string":
			return typeof value === "string";
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return !!value && typeof value === "object" && !Array.isArray(value);
		case "array":
			return Array.isArray(value);
		default:
			return true;
	}
}

function coerce(type: string, value: unknown): { ok: boolean; value?: unknown } {
	switch (type) {
		case "string":
			if (typeof value === "number" || typeof value === "boolean") return { ok: true, value: String(value) };
			// Objects for JSON-string fields (adapted schemas) are re-encoded.
			if (value && typeof value === "object") return { ok: true, value: JSON.stringify(value) };
			return { ok: false };
		case "integer":
		case "number": {
			const n = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
			if (!Number.isFinite(n)) return { ok: false };
			if (type === "integer" && !Number.isInteger(n)) return { ok: false };
			return { ok: true, value: n };
		}
		case "boolean":
			if (value === "true" || value === "false") return { ok: true, value: value === "true" };
			return { ok: false };
		case "object":
			if (typeof value === "string") {
				const parsed = tryParseJson(value);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, value: parsed };
			}
			return { ok: false };
		case "array":
			if (typeof value === "string") {
				const parsed = tryParseJson(value);
				if (Array.isArray(parsed)) return { ok: true, value: parsed };
				if (value.includes(",")) return { ok: true, value: value.split(",").map((s) => s.trim()) };
			}
			if (value !== undefined) return { ok: true, value: [value] };
			return { ok: false };
		default:
			return { ok: true, value };
	}
}

/**
 * Parse values the adapted schema declared as JSON-encoded strings back into
 * JSON. `paths` hold objects/arrays; `anyPaths` hold untyped values, where a
 * scalar like "42" or "true" is decoded too.
 */
export function decodeJsonArgs(
	args: Record<string, unknown>,
	paths: string[] | undefined,
	anyPaths: string[] = [],
): Record<string, unknown> {
	if ((!paths || paths.length === 0) && anyPaths.length === 0) return args;
	const root: Record<string, unknown> = { ...args };
	for (const path of paths ?? []) decodeAt(root, splitPath(path), false);
	for (const path of anyPaths) decodeAt(root, splitPath(path), true);
	return root;
}

function decodeAt(container: unknown, segments: string[], anyJson: boolean): void {
	if (!container || typeof container !== "object" || segments.length === 0) return;
	const [head, ...rest] = segments;
	if (head === "*") {
		if (!Array.isArray(container)) return;
		for (let i = 0; i < container.length; i++) {
			if (rest.length === 0) container[i] = parseIfJson(container[i], anyJson);
			else decodeAt(container[i], rest, anyJson);
		}
		return;
	}
	const obj = container as Record<string, unknown>;
	if (!(head in obj)) return;
	if (rest.length === 0) obj[head] = parseIfJson(obj[head], anyJson);
	else decodeAt(obj[head], rest, anyJson);
}

function parseIfJson(v: unknown, anyJson: boolean): unknown {
	if (typeof v !== "string") return v;
	if (anyJson) {
		try {
			return JSON.parse(v);
		} catch {
			return v; // plain text is a valid "any" value as-is
		}
	}
	const parsed = tryParseJson(v);
	return parsed && typeof parsed === "object" ? parsed : v;
}

function tryParseJson(s: string): unknown {
	const t = s.trim();
	if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
	try {
		return JSON.parse(t);
	} catch {
		return undefined;
	}
}

function stripNulls(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripNulls);
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (v !== null) out[k] = stripNulls(v);
	}
	return out;
}

function join(path: string, key: string): string {
	return path ? `${path}.${key}` : key;
}

function label(path: string): string {
	return path ? `'${path}'` : "arguments";
}

function describe(v: unknown): string {
	if (Array.isArray(v)) return "array";
	if (v === null) return "null";
	return typeof v === "string" ? `string ${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}...` : v)}` : typeof v;
}
