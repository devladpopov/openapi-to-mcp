import type { ClientTarget, JsonSchema } from "../types.js";
import { mergeAllOf, mergeInto } from "./merge.js";

/**
 * MCP clients forward tool input schemas to their model provider, and every
 * provider accepts a different subset of JSON Schema:
 *
 * - OpenAI (strict function calling, Agents SDK, ChatGPT connectors): every
 *   object needs `additionalProperties: false` and all properties listed in
 *   `required`; optional fields are expressed as nullable. `oneOf` is rejected
 *   (only `anyOf`), free-form objects cannot carry data, arrays need `items`.
 * - Gemini (function declarations use an OpenAPI subset): no
 *   `additionalProperties`, `oneOf`, `allOf`, `const`, type arrays or
 *   non-string enums; OBJECT types must declare non-empty `properties`; tool
 *   names must start with a letter or underscore.
 * - Bedrock (Converse tool specs): no `oneOf` / `anyOf` / `allOf`.
 * - Cursor: server name + tool name must fit in 60 characters.
 * - Anthropic: property keys must match ^[a-zA-Z0-9_.-]{1,64}$ (handled by the
 *   mapper for every target, since the same server is often used everywhere).
 *
 * `portable` is the intersection of all of the above: one generated server
 * that loads in every client, at the cost of some schema precision.
 */
export interface SchemaProfile {
	/** keep: emit anyOf; collapse: merge variants into a single schema. */
	unions: "keep" | "collapse";
	/** type-array: { type: ["string", "null"] }; drop: nullability removed. */
	nullable: "type-array" | "drop";
	/** keep: { type: "object" }; json-string: { type: "string" } parsed at runtime. */
	freeFormObjects: "keep" | "json-string";
	/** keep: as in the spec; strict: false on every object; drop: never emitted. */
	additionalProperties: "keep" | "strict" | "drop";
	/** Every property listed in `required`; optional ones become nullable. */
	allRequired: boolean;
	stringEnumsOnly: boolean;
	formats: "keep" | "openai" | "gemini";
	keepDefaults: boolean;
	/** Validation keywords copied through (minimum, pattern, ...). */
	constraints: readonly string[];
	maxDepth: number;
	maxEnumValues: number;
	maxPropertyDescription: number;
	maxToolDescription: number;
	/** Total budget for "<server>_<tool>"-style prefixes; null = 64-char MCP limit only. */
	combinedNameBudget: number | null;
	/** Tool names must start with a letter or underscore. */
	nameMustStartWithLetter: boolean;
	/** Warn above this many tools (client-side hard or soft limit). */
	maxTools: number | null;
}

const ALL_CONSTRAINTS = [
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minLength",
	"maxLength",
	"pattern",
	"minItems",
	"maxItems",
	"uniqueItems",
] as const;

const GENERIC: SchemaProfile = {
	unions: "keep",
	nullable: "type-array",
	freeFormObjects: "keep",
	additionalProperties: "keep",
	allRequired: false,
	stringEnumsOnly: false,
	formats: "keep",
	keepDefaults: true,
	constraints: ALL_CONSTRAINTS,
	maxDepth: 8,
	maxEnumValues: 500,
	maxPropertyDescription: 600,
	maxToolDescription: 4000,
	combinedNameBudget: null,
	nameMustStartWithLetter: false,
	maxTools: null,
};

export const PROFILES: Record<ClientTarget, SchemaProfile> = {
	generic: GENERIC,
	claude: GENERIC,
	openai: {
		...GENERIC,
		freeFormObjects: "json-string",
		additionalProperties: "strict",
		allRequired: true,
		formats: "openai",
		keepDefaults: false,
		constraints: [
			"minimum",
			"maximum",
			"exclusiveMinimum",
			"exclusiveMaximum",
			"multipleOf",
			"pattern",
			"minItems",
			"maxItems",
		],
		maxDepth: 5,
		maxToolDescription: 1024,
		maxTools: 128,
	},
	gemini: {
		...GENERIC,
		unions: "collapse",
		nullable: "drop",
		freeFormObjects: "json-string",
		additionalProperties: "drop",
		stringEnumsOnly: true,
		formats: "gemini",
		keepDefaults: false,
		constraints: ["minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems"],
		nameMustStartWithLetter: true,
		maxTools: 128,
	},
	cursor: { ...GENERIC, combinedNameBudget: 60, maxTools: 40 },
	bedrock: { ...GENERIC, unions: "collapse", nullable: "drop" },
	portable: {
		...GENERIC,
		unions: "collapse",
		nullable: "drop",
		freeFormObjects: "json-string",
		additionalProperties: "drop",
		stringEnumsOnly: true,
		formats: "gemini",
		keepDefaults: false,
		constraints: ["minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems"],
		maxDepth: 5,
		maxToolDescription: 1024,
		combinedNameBudget: 60,
		nameMustStartWithLetter: true,
		maxTools: 40,
	},
};

const OPENAI_FORMATS = new Set([
	"date-time",
	"time",
	"date",
	"duration",
	"email",
	"hostname",
	"ipv4",
	"ipv6",
	"uuid",
]);
const GEMINI_FORMATS: Record<string, Set<string>> = {
	string: new Set(["enum", "date-time"]),
	integer: new Set(["int32", "int64"]),
	number: new Set(["float", "double"]),
};
const PRIMITIVES = new Set(["string", "number", "integer", "boolean"]);
const MAX_UNION_VARIANTS = 30;
/** Input schemas above this size are re-adapted with a lower depth limit. */
const MAX_SCHEMA_CHARS = 60_000;

export interface AdaptedSchema {
	schema: JsonSchema;
	/**
	 * Paths (dot-separated, "*" = any array item) of values the client sends as
	 * JSON-encoded strings; the generated runtime parses them back.
	 */
	jsonPaths: string[];
	/**
	 * Paths where a union of different types was collapsed into one type. The
	 * API accepts more than the adapted schema says, so the runtime does not
	 * validate below these paths.
	 */
	loosePaths: string[];
	/** Like jsonPaths, for untyped values: JSON scalars ("42", "true") are decoded too. */
	anyPaths: string[];
}

/** Path segment escaping shared with the runtime (src/runtime/validate.ts). */
function seg(key: string): string {
	return key.replace(/%/g, "%25").replace(/\./g, "%2E");
}

/** Adapt a tool's top-level input schema (always an object) to a client profile. */
export function adaptInputSchema(input: JsonSchema, profile: SchemaProfile): AdaptedSchema {
	let result = adaptOnce(input, profile);
	// Huge request bodies (Cloudflare has 700KB schemas) blow up tools/list and
	// the model's context; trade nesting detail for size.
	for (let depth = Math.min(profile.maxDepth, 4); depth >= 2; depth--) {
		if (JSON.stringify(result.schema).length <= MAX_SCHEMA_CHARS) break;
		result = adaptOnce(input, { ...profile, maxDepth: depth, maxPropertyDescription: Math.min(profile.maxPropertyDescription, 200) });
	}
	return result;
}

function adaptOnce(input: JsonSchema, profile: SchemaProfile): AdaptedSchema {
	const jsonPaths: string[] = [];
	const loosePaths: string[] = [];
	const anyPaths: string[] = [];
	const ctx: Ctx = { profile, jsonPaths, loosePaths, anyPaths };
	const properties: Record<string, JsonSchema> = {};
	const required = new Set(input.required ?? []);
	for (const [key, prop] of Object.entries(input.properties ?? {})) {
		properties[key] = adaptNode(prop, ctx, 1, [seg(key)]);
	}
	const out: JsonSchema = { type: "object", properties };
	finishObject(out, required, ctx, true);
	return {
		schema: out,
		jsonPaths: [...new Set(jsonPaths)],
		loosePaths: [...new Set(loosePaths)],
		anyPaths: [...new Set(anyPaths)],
	};
}

interface Ctx {
	profile: SchemaProfile;
	jsonPaths: string[];
	loosePaths: string[];
	anyPaths: string[];
}

function adaptNode(raw: JsonSchema, ctx: Ctx, depth: number, path: string[]): JsonSchema {
	const { profile } = ctx;
	let schema = mergeAllOf(raw ?? {});
	let nullable = isNullable(schema);

	// Unions
	const variants = schema.anyOf ?? schema.oneOf;
	if (variants && variants.length > 0) {
		const nonNull = variants.filter((v) => !isNullOnly(v)).map(mergeAllOf);
		if (nonNull.length < variants.length) nullable = true;
		// Variants that only add constraints (`anyOf: [{required: [a]}, {required: [b]}]`)
		// do not describe alternative shapes; the base schema already does.
		const shaped = nonNull.filter((v) => !isConstraintOnly(v));
		const meaningful = shaped.filter((v) => !isEmptyStringEnum(v) || shaped.length === 1);
		const base = stripUnion(schema);
		if (meaningful.length === 0) {
			schema = base;
		} else if (meaningful.length === 1 || profile.unions === "collapse") {
			let single = meaningful[0];
			if (meaningful.length > 1) {
				const collapsed = collapseVariants(meaningful);
				single = collapsed.schema;
				if (collapsed.mixed) ctx.loosePaths.push(path.join("."));
			}
			return applyNullable(adaptNode(mergeInto(base, single), ctx, depth, path), nullable, profile);
		} else {
			const adapted = dedupe(
				meaningful.slice(0, MAX_UNION_VARIANTS).map((v) => adaptNode(v, ctx, depth + 1, path)),
			);
			// Variants that are identical after adaptation (e.g. two shapes of a
			// free-form object) collapse to one schema.
			if (adapted.length === 1) return finalizeLeaf(mergeDescription(adapted[0], base), nullable, ctx);
			const out: JsonSchema = { anyOf: adapted };
			copyDescription(out, base, profile);
			return applyNullable(out, nullable, profile);
		}
	}

	if (depth > profile.maxDepth) {
		return finalizeLeaf(opaque(schema, ctx, path), nullable, ctx);
	}

	const type = primaryType(schema);
	const out: JsonSchema = {};

	if (schema.const !== undefined && schema.enum === undefined) {
		schema = { ...schema, enum: [schema.const] };
	}

	if (type === "object") {
		const props = schema.properties ?? {};
		const entries = Object.entries(props).filter(([, v]) => !v?.readOnly);
		if (entries.length === 0) {
			return finalizeLeaf(freeForm(schema, ctx, path), nullable, ctx);
		}
		out.type = "object";
		out.properties = {};
		for (const [key, value] of entries) {
			out.properties[key] = adaptNode(value, ctx, depth + 1, [...path, seg(key)]);
		}
		copyDescription(out, schema, profile);
		finishObject(out, new Set(schema.required ?? []), ctx, false);
		if (profile.additionalProperties === "keep" && schema.additionalProperties === false) {
			out.additionalProperties = false;
		}
		return applyNullable(out, nullable, profile);
	}

	if (type === "array") {
		out.type = "array";
		const itemPath = [...path, "*"];
		out.items = schema.items ? adaptNode(schema.items, ctx, depth + 1, itemPath) : anyItems(ctx, itemPath);
		copyConstraints(out, schema, profile, "array");
		copyDescription(out, schema, profile);
		return applyNullable(out, nullable, profile);
	}

	if (!type) {
		// Untyped schema: any JSON value. Typed-only clients get a JSON string.
		if (profile.freeFormObjects === "json-string") {
			ctx.anyPaths.push(path.join("."));
			return { type: "string", description: joinDescription(schema.description, "any JSON value", profile) };
		}
		copyDescription(out, schema, profile);
		return out;
	}
	out.type = type;
	copyEnum(out, schema, ctx);
	copyFormat(out, schema, profile);
	copyConstraints(out, schema, profile, out.type as string);
	copyDescription(out, schema, profile);
	if (profile.keepDefaults && schema.default !== undefined && isPrimitiveValue(schema.default)) {
		out.default = schema.default;
	}
	return applyNullable(out, nullable, profile);
}

function finalizeLeaf(schema: JsonSchema, nullable: boolean, ctx: Ctx): JsonSchema {
	return applyNullable(schema, nullable, ctx.profile);
}

function finishObject(out: JsonSchema, required: Set<string>, ctx: Ctx, topLevel: boolean): void {
	const { profile } = ctx;
	const keys = Object.keys(out.properties ?? {});
	if (profile.allRequired) {
		for (const key of keys) {
			if (!required.has(key)) out.properties![key] = applyNullable(out.properties![key], true, profile);
		}
		out.required = keys;
	} else {
		const req = keys.filter((k) => required.has(k));
		if (req.length > 0) out.required = req;
	}
	if (profile.additionalProperties === "strict") out.additionalProperties = false;
	if (topLevel && !profile.allRequired && out.required?.length === 0) out.required = undefined;
}

/** A free-form object (no declared properties): a map or arbitrary JSON. */
function freeForm(schema: JsonSchema, ctx: Ctx, path: string[]): JsonSchema {
	const { profile } = ctx;
	if (profile.freeFormObjects === "json-string") {
		ctx.jsonPaths.push(path.join("."));
		const out: JsonSchema = {
			type: "string",
			description: joinDescription(schema.description, "JSON-encoded object", profile),
		};
		return out;
	}
	const out: JsonSchema = { type: "object" };
	if (profile.additionalProperties === "keep") {
		const ap = schema.additionalProperties;
		if (ap && typeof ap === "object" && primaryType(ap) && PRIMITIVES.has(primaryType(ap)!)) {
			out.additionalProperties = { type: primaryType(ap) };
		} else if (ap !== false) {
			out.additionalProperties = true;
		}
	}
	copyDescription(out, schema, profile);
	return out;
}

/** Schemas past the depth limit are accepted as opaque values. */
function opaque(schema: JsonSchema, ctx: Ctx, path: string[]): JsonSchema {
	const type = primaryType(schema);
	if (type && PRIMITIVES.has(type)) {
		const out: JsonSchema = { type };
		copyEnum(out, schema, ctx);
		copyDescription(out, schema, ctx.profile);
		return out;
	}
	if (type === "array" && ctx.profile.freeFormObjects === "keep") {
		const out: JsonSchema = { type: "array", items: {} };
		copyDescription(out, schema, ctx.profile);
		return out;
	}
	return freeForm({ description: schema.description, additionalProperties: true }, ctx, path);
}

function anyItems(ctx: Ctx, path: string[]): JsonSchema {
	if (ctx.profile.freeFormObjects === "json-string") {
		// OpenAI and Gemini both reject arrays without a typed `items`.
		ctx.anyPaths.push(path.join("."));
		return { type: "string", description: "JSON-encoded value" };
	}
	return {};
}

function applyNullable(schema: JsonSchema, nullable: boolean, profile: SchemaProfile): JsonSchema {
	if (!nullable || profile.nullable === "drop") return schema;
	if (schema.anyOf) {
		if (schema.anyOf.some(isNullOnly)) return schema;
		return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] };
	}
	if (typeof schema.type === "string") {
		const out: JsonSchema = { ...schema, type: [schema.type, "null"] };
		if (out.enum && !out.enum.includes(null)) out.enum = [...out.enum, null];
		return out;
	}
	if (schema.type === undefined && Object.keys(schema).every((k) => k === "description")) {
		return schema; // {} already accepts null
	}
	return schema;
}

function copyDescription(out: JsonSchema, src: JsonSchema, profile: SchemaProfile): void {
	// Titles are often schema identifiers (range_query_specs); only prose titles help.
	const title = typeof src.title === "string" && src.title.includes(" ") ? src.title : undefined;
	const desc = src.description ?? title;
	if (typeof desc === "string" && desc.trim()) {
		out.description = truncate(cleanText(desc), profile.maxPropertyDescription);
	}
}

function mergeDescription(schema: JsonSchema, base: JsonSchema): JsonSchema {
	if (!base.description || schema.description) return schema;
	return { ...schema, description: base.description };
}

function joinDescription(desc: unknown, note: string, profile: SchemaProfile): string {
	const base = typeof desc === "string" && desc.trim() ? cleanText(desc) : "";
	return truncate(base ? `${base} (${note})` : note, profile.maxPropertyDescription);
}

function copyEnum(out: JsonSchema, schema: JsonSchema, ctx: Ctx): void {
	if (!schema.enum || schema.enum.length === 0) return;
	const values = schema.enum.filter((v) => v !== null);
	if (values.length === 0) return;
	if (values.length > ctx.profile.maxEnumValues) {
		const shown = values.slice(0, 20).map((v) => JSON.stringify(v)).join(", ");
		out.description = truncate(
			`${out.description ?? ""} Known values include: ${shown}, ...`.trim(),
			ctx.profile.maxPropertyDescription,
		);
		return;
	}
	const allStrings = values.every((v) => typeof v === "string");
	if (ctx.profile.stringEnumsOnly && !allStrings) {
		const list = values.map((v) => JSON.stringify(v)).join(", ");
		out.description = truncate(
			`${schema.description ? `${cleanText(schema.description)} ` : ""}Allowed values: ${list}`,
			ctx.profile.maxPropertyDescription,
		);
		return;
	}
	// Enum values must match the declared type, otherwise clients reject the schema.
	const t = out.type;
	if (t === "string" && !allStrings) {
		out.enum = values.map((v) => String(v));
	} else if ((t === "integer" || t === "number") && !values.every((v) => typeof v === "number")) {
		out.type = allStrings ? "string" : t;
		out.enum = allStrings ? values : values.filter((v) => typeof v === "number");
	} else if (t === "boolean" && !values.every((v) => typeof v === "boolean")) {
		out.enum = undefined;
	} else {
		out.enum = values;
	}
}

function copyFormat(out: JsonSchema, schema: JsonSchema, profile: SchemaProfile): void {
	if (!schema.format) return;
	const type = out.type as string;
	if (profile.formats === "keep") out.format = schema.format;
	else if (profile.formats === "openai") {
		if (type === "string" && OPENAI_FORMATS.has(schema.format)) out.format = schema.format;
	} else if (GEMINI_FORMATS[type]?.has(schema.format)) out.format = schema.format;
}

function copyConstraints(out: JsonSchema, schema: JsonSchema, profile: SchemaProfile, type: string): void {
	for (const key of profile.constraints) {
		const value = schema[key];
		if (value === undefined) continue;
		const numeric = key !== "pattern" && key !== "uniqueItems";
		if (numeric && typeof value !== "number") continue; // 3.0 boolean exclusiveMinimum etc.
		const forType =
			key.endsWith("Items") || key === "uniqueItems"
				? type === "array"
				: key.endsWith("Length") || key === "pattern"
					? type === "string"
					: type === "number" || type === "integer";
		if (!forType) continue;
		if (key === "pattern" && !isPortableRegex(value as string)) continue;
		out[key] = value;
	}
}

/** Lookbehind, named groups and unicode classes break some providers' regex engines. */
function isPortableRegex(p: string): boolean {
	if (typeof p !== "string" || p.length > 200) return false;
	if (/\(\?<[=!]|\(\?<\w|\\p\{|\(\?[imsx]/.test(p)) return false;
	try {
		// Validators (ajv, provider-side) compile patterns in unicode mode, which
		// rejects escapes like \- or \_ that legacy mode accepts.
		new RegExp(p, "u");
		return true;
	} catch {
		return false;
	}
}

/** Merge alternative schemas into one, for clients that reject anyOf/oneOf. */
/** `mixed`: the variants had different types, so the result is narrower than the original. */
function collapseVariants(variants: JsonSchema[]): { schema: JsonSchema; mixed: boolean } {
	const typed = variants.map((v) => ({ v, t: primaryType(v) ?? (v.properties ? "object" : undefined) }));
	const rank = (t: string | undefined) =>
		t === "object" ? 0 : t === "array" ? 1 : t === "string" ? 2 : t === "number" ? 3 : t === "integer" ? 4 : 5;
	typed.sort((a, b) => rank(a.t) - rank(b.t));
	const winner = typed[0].t;
	const same = typed.filter((x) => x.t === winner).map((x) => x.v);
	const others = [...new Set(typed.filter((x) => x.t !== winner && x.t).map((x) => x.t as string))];

	let merged: JsonSchema;
	if (winner === "object") {
		// A property defined differently by several shapes (message.content as
		// string in one, parts array in another) becomes a union that the
		// recursive adaptation collapses again, instead of last-one-wins.
		const byKey = new Map<string, JsonSchema[]>();
		let required: string[] | null = null;
		for (const v of same) {
			for (const [k, p] of Object.entries(v.properties ?? {})) {
				const list = byKey.get(k) ?? [];
				if (!list.some((x) => JSON.stringify(x) === JSON.stringify(p))) list.push(p);
				byKey.set(k, list);
			}
			const r = v.required ?? [];
			required = required === null ? [...r] : required.filter((k) => r.includes(k));
		}
		const properties: Record<string, JsonSchema> = {};
		for (const [k, list] of byKey) {
			properties[k] = list.length === 1 ? list[0] : { anyOf: list, description: list.find((p) => p.description)?.description };
		}
		merged = { type: "object", properties };
		if (required && required.length > 0) merged.required = required;
		if (same.length > 1) {
			const names = same.map((v) => v.title ?? Object.keys(v.properties ?? {}).slice(0, 3).join("/"));
			merged.description = `One of ${same.length} shapes: ${names.filter(Boolean).join(" | ")}. Provide the fields of a single shape.`;
		}
		if (same.every((v) => !v.properties || Object.keys(v.properties).length === 0)) {
			merged = { type: "object", additionalProperties: same[0].additionalProperties ?? true };
		}
	} else if (winner === "array") {
		const items = same.map((v) => v.items).filter(Boolean) as JsonSchema[];
		// Item unions are collapsed (and flagged) when the items node is adapted.
		merged = { type: "array", items: items.length > 1 ? { anyOf: items } : (items[0] ?? {}) };
	} else {
		merged = { ...(same.find((v) => !v.enum) ?? same[0]) };
		const enums = [...new Set(same.flatMap((v) => v.enum ?? []))].filter((e) => e !== null && e !== "");
		if (same.length > 1) {
			if (same.every((v) => v.enum)) {
				merged.enum = enums;
			} else {
				// Open set with suggestions (model: string | "gpt-4o" | ...): keep the hints.
				merged.enum = undefined;
				if (enums.length > 0) {
					const shown = enums.slice(0, 15).map((e) => JSON.stringify(e)).join(", ");
					const note = `Known values: ${shown}${enums.length > 15 ? ", ..." : ""}.`;
					const base = same.find((v) => v.description)?.description;
					merged.description = base ? `${base} ${note}` : note;
				}
			}
		}
	}
	if (others.length > 0) {
		const note = `Also accepts: ${others.join(", ")}.`;
		merged.description = merged.description ? `${merged.description} ${note}` : note;
	}
	return { schema: merged, mixed: others.length > 0 };
}

function stripUnion(schema: JsonSchema): JsonSchema {
	const { anyOf: _a, oneOf: _o, ...rest } = schema;
	return rest;
}

function dedupe(schemas: JsonSchema[]): JsonSchema[] {
	const seen = new Set<string>();
	return schemas.filter((s) => {
		const key = JSON.stringify(s);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function primaryType(schema: JsonSchema): string | undefined {
	if (Array.isArray(schema.type)) return schema.type.find((t) => t !== "null");
	if (schema.type) return schema.type;
	if (schema.properties) return "object";
	if (schema.items) return "array";
	if (schema.enum?.length) {
		const v = schema.enum.find((x) => x !== null);
		return typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v === "boolean" ? "boolean" : "string";
	}
	if (schema.const !== undefined) return typeof schema.const === "number" ? "number" : typeof schema.const === "boolean" ? "boolean" : "string";
	if (schema.additionalProperties !== undefined) return "object";
	return undefined;
}

function isNullable(schema: JsonSchema): boolean {
	return (
		schema.nullable === true ||
		(Array.isArray(schema.type) && schema.type.includes("null")) ||
		(Array.isArray(schema.enum) && schema.enum.includes(null))
	);
}

function isNullOnly(schema: JsonSchema): boolean {
	return schema?.type === "null" || (Array.isArray(schema?.enum) && schema.enum.length === 1 && schema.enum[0] === null);
}

const SHAPE_KEYS = ["type", "properties", "items", "enum", "const", "anyOf", "oneOf", "allOf", "additionalProperties", "$ref", "format"];

function isConstraintOnly(schema: JsonSchema): boolean {
	return !SHAPE_KEYS.some((k) => schema[k] !== undefined);
}

function isEmptyStringEnum(schema: JsonSchema): boolean {
	return Array.isArray(schema.enum) && schema.enum.length === 1 && schema.enum[0] === "";
}

function isPrimitiveValue(v: unknown): boolean {
	return v === null || ["string", "number", "boolean"].includes(typeof v);
}

/** Collapse whitespace so multi-paragraph markdown stays compact in tool listings. */
export function cleanText(s: string): string {
	return s
		.replace(/<\/?(p|br|code|strong|em|b|i|a|ul|ol|li|span|div|h\d)(\s[^>]*)?\/?>/gi, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ")
		.replace(/\s+([.,;:)])/g, "$1")
		.trim();
}

export function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}
