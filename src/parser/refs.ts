import type { OpenApiSpec, JsonSchema } from "../types.js";

/**
 * Inline all $ref pointers in the spec. MCP clients (especially Claude Code,
 * Bedrock) don't handle $ref well, so we resolve everything upfront.
 */
export function resolveRefs(spec: OpenApiSpec): OpenApiSpec {
	const schemas = spec.components?.schemas ?? {};
	return JSON.parse(JSON.stringify(spec), (_key, value) => {
		if (value && typeof value === "object" && "$ref" in value) {
			const ref = value.$ref as string;
			const resolved = resolveRef(ref, schemas);
			if (resolved) return resolved;
		}
		return value;
	});
}

function resolveRef(ref: string, schemas: Record<string, JsonSchema>): JsonSchema | null {
	// Only handle local component refs: #/components/schemas/Foo
	const match = ref.match(/^#\/components\/schemas\/(.+)$/);
	if (!match) return null;
	const name = match[1];
	const schema = schemas[name];
	if (!schema) return null;
	// Return a copy to avoid circular mutation
	return JSON.parse(JSON.stringify(schema));
}
