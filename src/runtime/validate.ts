// Lenient JSON Schema validation for tool arguments.
//
// Models often send "5" for an integer, a JSON string for an object, or a
// single value for an array. Those are coerced instead of rejected; anything
// that cannot be coerced is reported back with the exact path so the model can
// fix its next call.

import type { JsonSchema } from "./types.js";

export interface ValidationResult {
	value: Record<string, unknown>;
	errors: string[];
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
	if (nullAsAbsent) stripNulls(obj);

	const props = schema.properties ?? {};
	const unknown = Object.keys(obj).filter((k) => !(k in props));
	if (unknown.length > 0) {
		errors.push(`unknown argument(s): ${unknown.join(", ")}. Valid arguments: ${Object.keys(props).join(", ") || "(none)"}`);
	}
	const value = check(schema, obj, "", "", errors, loose) as Record<string, unknown>;
	return { value, errors };
}

/** `path` is for messages (a.b[0]); `pattern` matches loose paths (a.b.*). */
function check(
	schema: JsonSchema | undefined,
	value: unknown,
	path: string,
	pattern: string,
	errors: string[],
	loose: Set<string>,
): unknown {
	if (!schema || typeof schema !== "object") return value;
	if (pattern && loose.has(pattern)) return value;

	if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
		for (const variant of schema.anyOf) {
			const attempt: string[] = [];
			const coerced = check(variant, value, path, pattern, attempt, loose);
			if (attempt.length === 0) return coerced;
		}
		errors.push(`${label(path)} does not match any of the allowed shapes`);
		return value;
	}

	const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
	if (value === null) {
		if (types.length === 0 || types.includes("null")) return null;
		errors.push(`${label(path)} must not be null`);
		return value;
	}
	if (types.length === 0) return value;

	let out: unknown = value;
	let matched = false;
	for (const type of types) {
		if (type === "null") continue;
		const r = coerce(type, value);
		if (r.ok) {
			out = r.value;
			matched = true;
			break;
		}
	}
	if (!matched) {
		errors.push(`${label(path)} must be ${types.filter((t) => t !== "null").join(" or ")}, got ${describe(value)}`);
		return value;
	}

	if (Array.isArray(schema.enum) && schema.enum.length > 0) {
		const allowed = schema.enum;
		const hit = allowed.find((v) => v === out || (v !== null && String(v) === String(out)));
		if (hit === undefined) {
			const list = allowed.slice(0, 25).map((v) => JSON.stringify(v)).join(", ");
			errors.push(`${label(path)} must be one of: ${list}${allowed.length > 25 ? ", ..." : ""}`);
		} else {
			out = hit;
		}
	}

	if (out && typeof out === "object" && !Array.isArray(out)) {
		const obj = out as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (obj[key] === undefined) errors.push(`${label(join(path, key))} is required`);
		}
		const props = schema.properties ?? {};
		const result: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(obj)) {
			if (v === undefined) continue;
			result[key] = props[key] ? check(props[key], v, join(path, key), join(pattern, key), errors, loose) : v;
		}
		return result;
	}
	if (Array.isArray(out) && schema.items) {
		return out.map((item, i) => check(schema.items, item, `${path}[${i}]`, join(pattern, "*"), errors, loose));
	}
	return out;
}

function coerce(type: string, value: unknown): { ok: boolean; value?: unknown } {
	switch (type) {
		case "string":
			if (typeof value === "string") return { ok: true, value };
			if (typeof value === "number" || typeof value === "boolean") return { ok: true, value: String(value) };
			// Objects for JSON-string fields (adapted schemas) are re-encoded.
			if (typeof value === "object") return { ok: true, value: JSON.stringify(value) };
			return { ok: false };
		case "integer":
		case "number": {
			const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
			if (Number.isNaN(n)) return { ok: false };
			if (type === "integer" && !Number.isInteger(n)) return { ok: false };
			return { ok: true, value: n };
		}
		case "boolean":
			if (typeof value === "boolean") return { ok: true, value };
			if (value === "true" || value === "false") return { ok: true, value: value === "true" };
			return { ok: false };
		case "object":
			if (value && typeof value === "object" && !Array.isArray(value)) return { ok: true, value };
			if (typeof value === "string") {
				const parsed = tryParseJson(value);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, value: parsed };
			}
			return { ok: false };
		case "array":
			if (Array.isArray(value)) return { ok: true, value };
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

/** Parse values the adapted schema declared as JSON-encoded strings back into objects. */
export function decodeJsonArgs(args: Record<string, unknown>, paths: string[] | undefined): Record<string, unknown> {
	if (!paths || paths.length === 0) return args;
	const root: Record<string, unknown> = { ...args };
	for (const path of paths) decodeAt(root, path.split("."));
	return root;
}

function decodeAt(container: unknown, segments: string[]): void {
	if (!container || typeof container !== "object" || segments.length === 0) return;
	const [head, ...rest] = segments;
	if (head === "*") {
		if (!Array.isArray(container)) return;
		for (let i = 0; i < container.length; i++) {
			if (rest.length === 0) container[i] = parseIfJson(container[i]);
			else decodeAt(container[i], rest);
		}
		return;
	}
	const obj = container as Record<string, unknown>;
	if (!(head in obj)) return;
	if (rest.length === 0) obj[head] = parseIfJson(obj[head]);
	else decodeAt(obj[head], rest);
}

function parseIfJson(v: unknown): unknown {
	if (typeof v !== "string") return v;
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

function stripNulls(obj: Record<string, unknown>): void {
	for (const [k, v] of Object.entries(obj)) {
		if (v === null) delete obj[k];
		else if (v && typeof v === "object" && !Array.isArray(v)) stripNulls(v as Record<string, unknown>);
	}
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
