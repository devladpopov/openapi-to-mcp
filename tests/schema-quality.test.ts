import { describe, expect, test } from "bun:test";
import { parseSpec } from "../src/parser/index.js";
import { mapToMcpTools } from "../src/mapper/index.js";
import { resolveRefs } from "../src/parser/refs.js";
import { resolve } from "node:path";
import type { OpenApiSpec } from "../src/types.js";

const fixture = resolve(import.meta.dir, "fixtures/complex-api.yaml");

describe("mapper: param locations and collisions", () => {
	test("body property colliding with path param is renamed", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const updateItem = tools.find((t) => t.name === "updateItem")!;

		expect(updateItem.inputSchema.properties!.id).toBeDefined();
		expect(updateItem.inputSchema.properties!.body_id).toBeDefined();
		expect(updateItem.meta.bodyParams).toContainEqual(["body_id", "id"]);
		expect(updateItem.meta.bodyParams).toContainEqual(["name", "name"]);
	});

	test("query params tracked separately from body params", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const updateItem = tools.find((t) => t.name === "updateItem")!;

		expect(updateItem.meta.queryParams).toEqual([["dry_run", "dry_run"]]);
		expect(updateItem.meta.pathParams).toEqual([["id", "id"]]);
		expect(updateItem.meta.bodyMode).toBe("fields");
	});

	test("non-object body uses whole-body mode", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const submitRaw = tools.find((t) => t.name === "submitRaw")!;

		expect(submitRaw.meta.bodyMode).toBe("whole");
		expect(submitRaw.meta.bodyParams).toEqual([["body", "*"]]);
	});

	test("form-encoded body detected with form content type", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const createCharge = tools.find((t) => t.name === "createCharge")!;

		expect(createCharge.meta.bodyContentType).toBe("form");
		expect(createCharge.meta.bodyMode).toBe("fields");
		expect(createCharge.inputSchema.required).toEqual(["amount"]);
	});

	test("json body keeps json content type", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		expect(tools.find((t) => t.name === "updateItem")!.meta.bodyContentType).toBe("json");
	});

	test("response hint appended to description", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const updateItem = tools.find((t) => t.name === "updateItem")!;

		expect(updateItem.description).toContain("Returns: { id, name, updated_at }");
	});

	test("duplicate tool names get unique suffixes", () => {
		const spec: OpenApiSpec = {
			openapi: "3.0.0",
			info: { title: "T", version: "1" },
			paths: {
				"/a": { get: { operationId: "doIt", responses: {} } },
				"/b": { get: { operationId: "doIt", responses: {} } },
			},
		};
		const tools = mapToMcpTools(spec);
		expect(tools.map((t) => t.name).sort()).toEqual(["doIt", "doIt_2"]);
	});

	test("long tool names truncated to MCP limit", () => {
		const longId = "x".repeat(100);
		const spec: OpenApiSpec = {
			openapi: "3.0.0",
			info: { title: "T", version: "1" },
			paths: {
				"/a": { get: { operationId: longId, responses: {} } },
			},
		};
		const tools = mapToMcpTools(spec);
		expect(tools[0].name.length).toBeLessThanOrEqual(64);
	});
});

describe("adapted input schema quality (generic target)", () => {
	async function updateItemSchema() {
		const spec = await parseSpec(fixture);
		return mapToMcpTools(spec).find((t) => t.name === "updateItem")!.inputSchema;
	}

	test("string enum kept", async () => {
		const s = await updateItemSchema();
		expect(s.properties!.status.enum).toEqual(["active", "archived"]);
		expect(s.properties!.status.type).toBe("string");
	});

	test("numeric enum kept with integer type", async () => {
		const s = await updateItemSchema();
		expect(s.properties!.priority).toMatchObject({ type: "integer", enum: [1, 2, 3] });
	});

	test("nested object with nullable field uses type array", async () => {
		const s = await updateItemSchema();
		const metadata = s.properties!.metadata;
		expect(metadata.properties!.color.type).toEqual(["string", "null"]);
		expect(metadata.properties!.sizes.type).toBe("array");
		expect(metadata.properties!.sizes.items!.properties!.value.type).toBe("number");
	});

	test("oneOf becomes anyOf", async () => {
		const s = await updateItemSchema();
		expect(s.properties!.variant.anyOf).toEqual([{ type: "string" }, { type: "integer" }]);
	});

	test("required lists path param and body required fields", async () => {
		const s = await updateItemSchema();
		expect(s.required).toEqual(["id", "name"]);
	});
});

describe("ref resolution", () => {
	test("circular refs are truncated, not infinite", async () => {
		const spec = await parseSpec(fixture);
		// complex-api.yaml has Node referencing itself
		const json = JSON.stringify(spec);
		expect(json).toContain("circular reference truncated");
	});

	test("nested refs resolved recursively", () => {
		const spec = {
			openapi: "3.0.0",
			info: { title: "T", version: "1" },
			paths: {},
			components: {
				schemas: {
					A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" } } },
					B: { type: "object", properties: { name: { type: "string" } } },
				},
			},
		} as unknown as OpenApiSpec;
		const resolved = resolveRefs(spec);
		const a = resolved.components!.schemas!.A;
		expect(a.properties!.b.properties!.name.type).toBe("string");
	});
});
