import { describe, expect, test } from "bun:test";
import { parseSpec } from "../src/parser/index.js";
import { resolve } from "node:path";

const fixture = resolve(import.meta.dir, "fixtures/petstore.yaml");

describe("parseSpec", () => {
	test("loads and parses YAML spec", async () => {
		const spec = await parseSpec(fixture);
		expect(spec.openapi).toBe("3.0.3");
		expect(spec.info.title).toBe("Petstore");
		expect(spec.info.version).toBe("1.0.0");
	});

	test("resolves paths", async () => {
		const spec = await parseSpec(fixture);
		expect(Object.keys(spec.paths)).toEqual(["/pets", "/pets/{petId}"]);
	});

	test("resolves $ref in request body", async () => {
		const spec = await parseSpec(fixture);
		const createPet = spec.paths["/pets"].post!;
		const bodySchema = createPet.requestBody!.content["application/json"].schema!;
		// $ref should be resolved to inline schema
		expect(bodySchema.type).toBe("object");
		expect(bodySchema.properties!.name.type).toBe("string");
		expect(bodySchema.required).toContain("name");
	});

	test("resolves $ref in response schema", async () => {
		const spec = await parseSpec(fixture);
		const getPet = spec.paths["/pets/{petId}"].get!;
		const responseSchema = getPet.responses!["200"].content!["application/json"].schema!;
		expect(responseSchema.type).toBe("object");
		expect(responseSchema.properties!.id.type).toBe("string");
		expect(responseSchema.properties!.name.type).toBe("string");
	});

	test("preserves servers", async () => {
		const spec = await parseSpec(fixture);
		expect(spec.servers![0].url).toBe("https://petstore.example.com/v1");
	});

	test("preserves securitySchemes", async () => {
		const spec = await parseSpec(fixture);
		expect(spec.components!.securitySchemes!.ApiKey.type).toBe("apiKey");
		expect(spec.components!.securitySchemes!.ApiKey.name).toBe("X-API-Key");
	});

	test("rejects non-OpenAPI files", async () => {
		const badFile = resolve(import.meta.dir, "../package.json");
		await expect(parseSpec(badFile)).rejects.toThrow("missing 'openapi' version field");
	});

	test("rejects OpenAPI 2.x (Swagger)", async () => {
		// Create a temp swagger spec
		const tmpFile = resolve(import.meta.dir, "fixtures/swagger2.yaml");
		await Bun.write(tmpFile, 'swagger: "2.0"\ninfo:\n  title: Old\n  version: "1"\npaths: {}');
		await expect(parseSpec(tmpFile)).rejects.toThrow("missing 'openapi' version field");
	});
});
