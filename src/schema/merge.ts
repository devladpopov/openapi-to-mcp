import type { JsonSchema } from "../types.js";

/** Flatten allOf into a single schema (properties and required are unioned). */
export function mergeAllOf(schema: JsonSchema): JsonSchema {
	if (!schema || !Array.isArray(schema.allOf) || schema.allOf.length === 0) return schema;
	const { allOf, ...rest } = schema;
	let out: JsonSchema = { ...rest };
	for (const part of allOf) {
		if (!part || typeof part !== "object") continue;
		out = mergeInto(out, mergeAllOf(part));
	}
	return out;
}

/** Shallow structural merge: properties and required are unioned, b fills gaps in a. */
export function mergeInto(a: JsonSchema, b: JsonSchema): JsonSchema {
	const out: JsonSchema = { ...b, ...stripUndefined(a) };
	if (a.properties || b.properties) {
		// Keep declaration order; on conflicts the existing definition (a) wins.
		const props: Record<string, JsonSchema> = { ...(a.properties ?? {}) };
		for (const [k, v] of Object.entries(b.properties ?? {})) if (!(k in props)) props[k] = v;
		out.properties = props;
	}
	if (a.required || b.required) out.required = [...new Set([...(a.required ?? []), ...(b.required ?? [])])];
	if (!a.type && b.type) out.type = b.type;
	if (out.properties && !out.type) out.type = "object";
	if (a.description && b.description && a.description !== b.description) out.description = a.description;
	// Union keywords from the merged-in variant are resolved by the caller.
	if (!a.anyOf && !a.oneOf) {
		out.anyOf = b.anyOf;
		out.oneOf = b.oneOf;
	}
	return stripUndefined(out);
}

function stripUndefined(s: JsonSchema): JsonSchema {
	const out: JsonSchema = {};
	for (const [k, v] of Object.entries(s)) if (v !== undefined) out[k] = v;
	return out;
}

