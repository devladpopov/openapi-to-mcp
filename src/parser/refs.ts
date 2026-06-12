import type { OpenApiSpec } from "../types.js";

/**
 * Inline all $ref pointers in the spec. MCP clients (especially Claude Code,
 * Bedrock) don't handle $ref well, so we resolve everything upfront.
 *
 * Handles:
 * - any local JSON pointer (#/components/schemas/Foo, #/components/parameters/Bar, ...)
 * - nested refs (refs inside resolved targets are resolved recursively)
 * - circular refs (replaced with a placeholder to avoid infinite expansion)
 */
export function resolveRefs(spec: OpenApiSpec): OpenApiSpec {
	const root = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
	const MAX_DEPTH = 64;

	function lookup(ref: string): unknown {
		if (!ref.startsWith("#/")) return null;
		const parts = ref
			.slice(2)
			.split("/")
			.map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
		let cur: unknown = root;
		for (const p of parts) {
			if (cur === null || typeof cur !== "object") return null;
			cur = (cur as Record<string, unknown>)[p];
		}
		return cur ?? null;
	}

	function resolve(node: unknown, stack: readonly string[], depth: number): unknown {
		if (node === null || typeof node !== "object") return node;
		if (depth > MAX_DEPTH) {
			return Array.isArray(node) ? [] : {};
		}
		if (Array.isArray(node)) {
			return node.map((n) => resolve(n, stack, depth + 1));
		}
		const obj = node as Record<string, unknown>;
		if (typeof obj.$ref === "string") {
			const ref = obj.$ref;
			if (stack.includes(ref)) {
				// Circular reference: truncate with a permissive placeholder.
				return { type: "object", description: "(circular reference truncated)" };
			}
			const target = lookup(ref);
			if (target === null || target === undefined) {
				// External or unresolvable ref: strip $ref, keep siblings.
				const { $ref: _discard, ...rest } = obj;
				return resolve(rest, stack, depth + 1);
			}
			return resolve(target, [...stack, ref], depth + 1);
		}
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(obj)) {
			out[k] = resolve(v, stack, depth + 1);
		}
		return out;
	}

	return resolve(root, [], 0) as OpenApiSpec;
}
