import { describe, expect, test } from "bun:test";
import { parseSpec } from "../src/parser/index.js";
import { mapToMcpTools } from "../src/mapper/index.js";
import { resolve } from "node:path";

const fixture = resolve(import.meta.dir, "fixtures/petstore.yaml");

describe("mapToMcpTools", () => {
	test("maps all operations to tools", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		expect(tools.length).toBe(4);
		expect(tools.map((t) => t.name).sort()).toEqual([
			"createPet",
			"deletePet",
			"getPet",
			"listPets",
		]);
	});

	test("listPets has correct schema", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const listPets = tools.find((t) => t.name === "listPets")!;

		expect(listPets.description).toStartWith("List all pets");
		expect(listPets.inputSchema.type).toBe("object");
		expect(listPets.inputSchema.properties!.limit.type).toBe("integer");
		expect(listPets.inputSchema.required).toBeUndefined(); // limit is optional
		expect(listPets.meta.method).toBe("GET");
		expect(listPets.meta.path).toBe("/pets");
		expect(listPets.meta.tags).toEqual(["pets"]);
	});

	test("createPet flattens request body properties", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const createPet = tools.find((t) => t.name === "createPet")!;

		expect(createPet.inputSchema.properties!.name.type).toBe("string");
		expect(createPet.inputSchema.properties!.tag.type).toBe("string");
		expect(createPet.inputSchema.required).toContain("name");
		expect(createPet.meta.method).toBe("POST");
	});

	test("getPet has path parameter", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const getPet = tools.find((t) => t.name === "getPet")!;

		expect(getPet.inputSchema.properties!.petId.type).toBe("string");
		expect(getPet.inputSchema.required).toContain("petId");
	});

	test("excludeTags filters operations", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec, { excludeTags: ["pets"] });
		expect(tools.length).toBe(0);
	});

	test("includeTags filters operations", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec, { includeTags: ["nonexistent"] });
		expect(tools.length).toBe(0);
	});

	test("excludeOperations filters by name", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec, { excludeOperations: ["deletePet", "createPet"] });
		expect(tools.length).toBe(2);
		expect(tools.map((t) => t.name).sort()).toEqual(["getPet", "listPets"]);
	});

	test("generates tool name when operationId is missing", async () => {
		const spec = await parseSpec(fixture);
		// Remove operationIds
		for (const pathItem of Object.values(spec.paths)) {
			for (const method of ["get", "post", "put", "patch", "delete"] as const) {
				if (pathItem[method]) {
					delete pathItem[method]!.operationId;
				}
			}
		}
		const tools = mapToMcpTools(spec);
		expect(tools.length).toBe(4);
		// Should auto-generate names from method + path
		const names = tools.map((t) => t.name).sort();
		expect(names).toContain("get_pets");
		expect(names).toContain("post_pets");
		expect(names).toContain("get_pets_by_petId");
		expect(names).toContain("delete_pets_by_petId");
	});
});
