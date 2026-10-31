import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { mapToMcpTools } from "../src/mapper/index.js";
import { parseSpec } from "../src/parser/index.js";
import { PROFILES, adaptInputSchema } from "../src/schema/adapt.js";
import type { ClientTarget, JsonSchema, OpenApiSpec } from "../src/types.js";

const complex = resolve(import.meta.dir, "fixtures/complex-api.yaml");

const sample: JsonSchema = {
	type: "object",
	required: ["id"],
	properties: {
		id: { type: "string", format: "uuid" },
		note: { type: "string", nullable: true },
		priority: { type: "integer", enum: [1, 2, 3] },
		kind: { const: "task" },
		metadata: { type: "object", additionalProperties: { type: "string" } },
		target: {
			oneOf: [
				{ type: "object", title: "User", properties: { user_id: { type: "string" } }, required: ["user_id"] },
				{ type: "object", title: "Team", properties: { team_id: { type: "string" } }, required: ["team_id"] },
			],
		},
		expand: { anyOf: [{ type: "string", maxLength: 5000 }, { type: "string", enum: [""] }] },
		tags: { type: "array" },
		extra: {},
		filter: {
			type: "object",
			properties: { status: { type: "string" } },
			anyOf: [{ required: ["status"] }],
		},
		created: { type: "string", format: "date-time", readOnly: false, example: "2024-01-01", "x-internal": true },
		owner: { allOf: [{ type: "object", properties: { name: { type: "string" } } }, { properties: { email: { type: "string" } } }] },
	},
};

function adapt(target: ClientTarget) {
	return adaptInputSchema(sample, PROFILES[target]);
}

/** Walk every subschema. */
function walk(schema: JsonSchema, fn: (s: JsonSchema) => void): void {
	fn(schema);
	for (const v of Object.values(schema.properties ?? {})) walk(v, fn);
	if (schema.items) walk(schema.items, fn);
	for (const v of schema.anyOf ?? []) walk(v, fn);
	if (schema.additionalProperties && typeof schema.additionalProperties === "object") walk(schema.additionalProperties, fn);
}

describe("schema adaptation: generic", () => {
	const { schema, jsonPaths } = adapt("generic");
	const p = schema.properties!;

	test("unions become anyOf and keep shapes", () => {
		expect(p.target.anyOf).toHaveLength(2);
		expect(p.target.anyOf![0].properties!.user_id.type).toBe("string");
	});

	test("nullable uses type arrays, const becomes enum", () => {
		expect(p.note.type).toEqual(["string", "null"]);
		expect(p.kind).toMatchObject({ type: "string", enum: ["task"] });
	});

	test("empty-string unset variant is dropped from unions", () => {
		expect(p.expand).toMatchObject({ type: "string", maxLength: 5000 });
		expect(p.expand.anyOf).toBeUndefined();
	});

	test("constraint-only anyOf variants are ignored", () => {
		expect(p.filter.type).toBe("object");
		expect(p.filter.anyOf).toBeUndefined();
		expect(p.filter.properties!.status.type).toBe("string");
	});

	test("allOf merged, unknown keywords dropped", () => {
		expect(Object.keys(p.owner.properties!)).toEqual(["name", "email"]);
		expect(p.created).toEqual({ type: "string", format: "date-time" });
	});

	test("maps keep typed additionalProperties, untyped stays any", () => {
		expect(p.metadata).toEqual({ type: "object", additionalProperties: { type: "string" } });
		expect(p.extra).toEqual({});
		expect(p.tags).toEqual({ type: "array", items: {} });
		expect(jsonPaths).toEqual([]);
	});
});

describe("schema adaptation: openai (strict-compatible)", () => {
	const { schema, jsonPaths } = adapt("openai");

	test("every object is closed and lists all properties as required", () => {
		walk(schema, (s) => {
			if (s.type === "object" || (Array.isArray(s.type) && s.type.includes("object"))) {
				expect(s.additionalProperties).toBe(false);
				expect(s.required?.sort()).toEqual(Object.keys(s.properties ?? {}).sort());
			}
		});
	});

	test("optional fields become nullable, required stay non-null", () => {
		expect(schema.properties!.id.type).toBe("string");
		expect(schema.properties!.priority.type).toEqual(["integer", "null"]);
		expect(schema.properties!.priority.enum).toEqual([1, 2, 3, null]);
	});

	test("free-form objects and untyped arrays become JSON strings", () => {
		expect(schema.properties!.metadata.type).toEqual(["string", "null"]);
		expect(schema.properties!.tags.items!.type).toBe("string");
		expect(jsonPaths).toEqual(expect.arrayContaining(["metadata", "tags.*", "extra"]));
	});

	test("no oneOf anywhere and only supported formats", () => {
		const text = JSON.stringify(schema);
		expect(text).not.toContain("oneOf");
		expect(text).not.toContain('"default"');
		expect(schema.properties!.id.format).toBe("uuid");
	});
});

describe("schema adaptation: gemini", () => {
	const { schema, jsonPaths } = adapt("gemini");

	test("no unions, type arrays, additionalProperties or const", () => {
		walk(schema, (s) => {
			expect(s.anyOf).toBeUndefined();
			expect(s.oneOf).toBeUndefined();
			expect(s.additionalProperties).toBeUndefined();
			expect(Array.isArray(s.type)).toBe(false);
			expect(s.const).toBeUndefined();
		});
	});

	test("object unions are merged into one shape", () => {
		const target = schema.properties!.target;
		expect(Object.keys(target.properties!).sort()).toEqual(["team_id", "user_id"]);
		expect(target.required).toBeUndefined();
		expect(target.description).toContain("User | Team");
	});

	test("non-string enums move into the description", () => {
		const priority = schema.properties!.priority;
		expect(priority.enum).toBeUndefined();
		expect(priority.description).toContain("Allowed values: 1, 2, 3");
	});

	test("free-form values become JSON strings, objects always have properties", () => {
		expect(schema.properties!.metadata.type).toBe("string");
		walk(schema, (s) => {
			if (s.type === "object") expect(Object.keys(s.properties ?? {}).length).toBeGreaterThan(0);
		});
		expect(jsonPaths).toEqual(expect.arrayContaining(["metadata", "extra", "tags.*"]));
	});

	test("unsupported formats are dropped", () => {
		expect(schema.properties!.id.format).toBeUndefined();
		expect(schema.properties!.created.format).toBe("date-time");
	});
});

describe("collapsed unions", () => {
	const content: JsonSchema = {
		type: "object",
		properties: {
			content: { anyOf: [{ type: "string" }, { type: "array", items: { type: "object", properties: { text: { type: "string" } } } }] },
			model: { anyOf: [{ type: "string" }, { type: "string", enum: ["small", "large"] }] },
		},
	};

	test("mixed-type unions are flagged loose so the runtime accepts every variant", () => {
		const { schema, loosePaths } = adaptInputSchema(content, PROFILES.gemini);
		expect(schema.properties!.content.type).toBe("array");
		expect(schema.properties!.content.description).toContain("Also accepts: string");
		expect(loosePaths).toEqual(["content"]);
	});

	test("open string sets keep enum values as hints", () => {
		const { schema, loosePaths } = adaptInputSchema(content, PROFILES.bedrock);
		expect(schema.properties!.model).toEqual({ type: "string", description: 'Known values: "small", "large".' });
		expect(loosePaths).not.toContain("model");
	});

	test("generic keeps the union and needs no loose paths", () => {
		expect(adaptInputSchema(content, PROFILES.generic).loosePaths).toEqual([]);
	});
});

describe("schema adaptation: bedrock and portable", () => {
	test("bedrock collapses unions but keeps maps", () => {
		const { schema } = adapt("bedrock");
		expect(JSON.stringify(schema)).not.toContain("anyOf");
		expect(schema.properties!.metadata.type).toBe("object");
	});

	test("portable satisfies gemini and openai-non-strict constraints", () => {
		const { schema } = adapt("portable");
		walk(schema, (s) => {
			expect(s.anyOf).toBeUndefined();
			expect(s.additionalProperties).toBeUndefined();
			expect(Array.isArray(s.type)).toBe(false);
			if (s.type === "array") expect(s.items?.type).toBeDefined();
		});
	});
});

describe("tool-level adaptation", () => {
	const long: OpenApiSpec = {
		openapi: "3.0.0",
		info: { title: "Acme Enterprise Platform API", version: "1" },
		paths: {
			"/a": { get: { operationId: "listAllEnterpriseOrganizationMembersWithRoles", responses: {} } },
			"/b": { get: { operationId: "1stParty", responses: {} } },
		},
	};

	test("cursor target fits server + tool name into 60 chars", () => {
		const tools = mapToMcpTools(long, { target: "cursor" });
		for (const t of tools) expect(`acme-enterprise-platform-api_${t.name}`.length).toBeLessThanOrEqual(60);
	});

	test("gemini tool names start with a letter", () => {
		const tools = mapToMcpTools(long, { target: "gemini" });
		expect(tools.find((t) => t.name.endsWith("1stParty"))!.name).toBe("op_1stParty");
	});

	test("openai tool descriptions are capped at 1024 chars", () => {
		const spec: OpenApiSpec = {
			openapi: "3.0.0",
			info: { title: "T", version: "1" },
			paths: { "/x": { post: { operationId: "x", summary: "Do x", description: "y".repeat(5000), responses: {} } } },
		};
		expect(mapToMcpTools(spec, { target: "openai" })[0].description.length).toBeLessThanOrEqual(1024);
	});

	test("every target produces valid schemas for the complex fixture", async () => {
		const spec = await parseSpec(complex);
		for (const target of Object.keys(PROFILES) as ClientTarget[]) {
			const tools = mapToMcpTools(spec, { target });
			for (const t of tools) {
				expect(t.inputSchema.type).toBe("object");
				expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
				for (const key of Object.keys(t.inputSchema.properties ?? {})) expect(key).toMatch(/^[a-zA-Z0-9_.-]{1,64}$/);
			}
		}
	});

	test("huge schemas are reduced in depth", () => {
		const deep = (n: number): JsonSchema =>
			n === 0
				? { type: "string", description: "leaf ".repeat(50) }
				: { type: "object", properties: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}`, deep(n - 1)])) };
		const { schema } = adaptInputSchema({ type: "object", properties: { body: deep(6) } }, PROFILES.generic);
		expect(JSON.stringify(schema).length).toBeLessThanOrEqual(60_000);
	});
});
