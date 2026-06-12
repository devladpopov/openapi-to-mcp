import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { parseSpec } from "../src/parser/index.js";
import { mapToMcpTools } from "../src/mapper/index.js";
import { generate } from "../src/generator/index.js";
import { resolveRefs } from "../src/parser/refs.js";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
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

		expect(updateItem.meta.queryParams).toEqual(["dry_run"]);
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

describe("generated code: query/body separation", () => {
	let outputDir: string;

	beforeEach(() => {
		outputDir = mkdtempSync(join(tmpdir(), "openapi-to-mcp-sq-"));
	});

	afterEach(() => {
		if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
	});

	async function generateCode(): Promise<string> {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools, spec, outputDir,
			serverName: "Complex", transport: "stdio", auth: "none",
		});
		return readFileSync(join(outputDir, "src/server.ts"), "utf-8");
	}

	test("POST with query params appends query string", async () => {
		const code = await generateCode();
		expect(code).toContain('buildQuery(p, ["locale"])');
	});

	test("body assembled from body params only, with collision mapping", async () => {
		const code = await generateCode();
		expect(code).toContain('pickBody(p, [["name","name"],["body_id","id"]');
	});

	test("path params are URL-encoded", async () => {
		const code = await generateCode();
		expect(code).toContain('encodeURIComponent(String(p["id"] ?? ""))');
	});

	test("form-encoded body uses formEncode and form content type", async () => {
		const code = await generateCode();
		expect(code).toContain("formEncode(pickBody(p,");
		expect(code).toContain('"Content-Type": "application/x-www-form-urlencoded"');
	});

	test("whole-body payload sent as-is", async () => {
		const code = await generateCode();
		expect(code).toContain('pickBody(p, [["body","*"]])');
	});
});

describe("generated code: zod quality", () => {
	let outputDir: string;

	beforeEach(() => {
		outputDir = mkdtempSync(join(tmpdir(), "openapi-to-mcp-zq-"));
	});

	afterEach(() => {
		if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
	});

	async function generateCode(): Promise<string> {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools, spec, outputDir,
			serverName: "Complex", transport: "stdio", auth: "none",
		});
		return readFileSync(join(outputDir, "src/server.ts"), "utf-8");
	}

	test("string enum renders z.enum", async () => {
		const code = await generateCode();
		expect(code).toContain('z.enum(["active", "archived"])');
	});

	test("numeric enum renders literal union", async () => {
		const code = await generateCode();
		expect(code).toContain("z.union([z.literal(1), z.literal(2), z.literal(3)])");
	});

	test("nested object renders z.object with nullable field", async () => {
		const code = await generateCode();
		expect(code).toContain('"color": z.string().nullable().optional()');
		expect(code).toContain('"sizes": z.array(z.object({');
	});

	test("oneOf renders z.union", async () => {
		const code = await generateCode();
		expect(code).toContain("z.union([z.string(), z.number().int()])");
	});

	test("integer renders z.number().int()", async () => {
		const code = await generateCode();
		expect(code).toContain("z.number().int()");
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
