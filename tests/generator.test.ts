import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RUNTIME_FILES } from "../src/generator/runtime-sources.js";
import { renderEmbedded } from "../scripts/embed-runtime.js";
import { type Generated, generateFixture } from "./helpers.js";

const petstore = resolve(import.meta.dir, "fixtures/petstore.yaml");
let gen: Generated | undefined;

afterEach(() => {
	gen?.cleanup();
	gen = undefined;
});

describe("generate", () => {
	test("creates all expected files", async () => {
		gen = await generateFixture(petstore);
		for (const f of [
			"src/server.ts",
			"src/config.ts",
			"src/http.ts",
			"src/auth.ts",
			"src/validate.ts",
			"src/webhooks.ts",
			"src/types.ts",
			"tools.json",
			"package.json",
			"tsconfig.json",
			".env.example",
			"README.md",
			".gitignore",
		]) {
			expect(existsSync(join(gen.dir, f))).toBe(true);
		}
	});

	test("tools.json contains all tools with routing data", async () => {
		gen = await generateFixture(petstore);
		const { tools } = gen.toolsJson();
		expect(tools.map((t) => t.name).sort()).toEqual(["createPet", "deletePet", "getPet", "listPets"]);
		const getPet = tools.find((t) => t.name === "getPet")!;
		expect(getPet.method).toBe("GET");
		expect(getPet.path).toBe("/pets/{petId}");
		expect(getPet.pathParams).toEqual([["petId", "petId"]]);
		expect(getPet.inputSchema.type).toBe("object");
		expect(getPet.annotations.readOnlyHint).toBe(true);
		const deletePet = tools.find((t) => t.name === "deletePet")!;
		expect(deletePet.annotations.destructiveHint).toBe(true);
	});

	test("server uses the low-level MCP Server and stdio transport", async () => {
		gen = await generateFixture(petstore);
		const code = gen.file("src/server.ts");
		expect(code).toContain("new Server(");
		expect(code).toContain("StdioServerTransport");
		expect(code).toContain("ListToolsRequestSchema");
		expect(code).toContain('"../tools.json"');
		expect(gen.config()).toContain('"transport": "stdio"');
	});

	test("runtime files are written verbatim from src/runtime", async () => {
		gen = await generateFixture(petstore);
		for (const [name, text] of Object.entries(RUNTIME_FILES)) {
			expect(gen.file(`src/${name}`)).toBe(text);
		}
	});

	test("embedded runtime is in sync with src/runtime (run `bun scripts/embed-runtime.ts`)", () => {
		const current = readFileSync(resolve(import.meta.dir, "../src/generator/runtime-sources.ts"), "utf-8").replace(
			/\r\n/g,
			"\n",
		);
		expect(current).toBe(renderEmbedded());
	});

	test("generated package.json has correct name and deps", async () => {
		gen = await generateFixture(petstore, { name: "My Test API" });
		const pkg = JSON.parse(gen.file("package.json"));
		expect(pkg.name).toBe("my-test-api");
		expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBeDefined();
		expect(pkg.type).toBe("module");
		expect(pkg.files).toContain("tools.json");
	});

	test("api-key auth reads header name from spec", async () => {
		gen = await generateFixture(petstore, { auth: "api-key" });
		const config = gen.config();
		expect(config).toContain('"mode": "api-key"');
		expect(config).toContain('"apiKeyName": "X-API-Key"');
		expect(config).toContain('"apiKeyIn": "header"');
		expect(gen.file(".env.example")).toContain("API_KEY=");
	});

	test("bearer and basic auth modes", async () => {
		gen = await generateFixture(petstore, { auth: "bearer" });
		expect(gen.config()).toContain('"mode": "bearer"');
		expect(gen.file(".env.example")).toContain("API_TOKEN=");
		gen.cleanup();
		gen = await generateFixture(petstore, { auth: "basic" });
		expect(gen.config()).toContain('"mode": "basic"');
		expect(gen.file(".env.example")).toContain("API_USERNAME=");
	});

	test("oauth2 client credentials mode", async () => {
		gen = await generateFixture(petstore, { auth: "oauth2" });
		expect(gen.config()).toContain('"mode": "oauth2"');
		const env = gen.file(".env.example");
		expect(env).toContain("OAUTH_CLIENT_ID=");
		expect(env).toContain("OAUTH_TOKEN_URL=");
		expect(gen.file("src/auth.ts")).toContain("client_credentials");
	});

	test(".env.example has base URL from spec", async () => {
		gen = await generateFixture(petstore, { auth: "api-key" });
		expect(gen.file(".env.example")).toContain("API_BASE_URL=https://petstore.example.com/v1");
	});

	test("server name is slugified in package.json", async () => {
		gen = await generateFixture(petstore, { name: "My Fancy API v2.0" });
		expect(JSON.parse(gen.file("package.json")).name).toBe("my-fancy-api-v2-0");
	});

	test("README documents tools and client setup", async () => {
		gen = await generateFixture(petstore, { name: "Petstore" });
		const readme = gen.file("README.md");
		expect(readme).toContain("claude mcp add petstore");
		expect(readme).toContain("`listPets`");
		expect(readme).toContain("mcp_servers.petstore");
	});
});

describe("feature data in tools.json", () => {
	test("pagination config is emitted", async () => {
		gen = await generateFixture(resolve(import.meta.dir, "fixtures/paginated-api.yaml"));
		const listItems = gen.toolsJson().tools.find((t) => t.name === "listItems")!;
		expect(listItems.pagination.type).toBe("offset");
		expect(listItems.inputSchema.properties.cursor.type).toBe("string");
		const simple = gen.toolsJson().tools.find((t) => t.name === "getSimple")!;
		expect(simple.pagination).toBeUndefined();
	});

	test("streaming flag is emitted", async () => {
		gen = await generateFixture(resolve(import.meta.dir, "fixtures/streaming-api.yaml"));
		const tools = gen.toolsJson().tools;
		expect(tools.find((t) => t.name === "streamEvents")!.streaming).toBe(true);
		expect(tools.find((t) => t.name === "getData")!.streaming).toBeUndefined();
	});

	test("streamable-http transport is configured", async () => {
		gen = await generateFixture(petstore, { transport: "streamable-http" });
		expect(gen.config()).toContain('"transport": "streamable-http"');
		const code = gen.file("src/server.ts");
		expect(code).toContain("StreamableHTTPServerTransport");
		expect(code).toContain("http.handleRequest(req, res)");
		expect(code).toContain('"/mcp"');
	});

	test("form and whole-body routing data", async () => {
		gen = await generateFixture(resolve(import.meta.dir, "fixtures/complex-api.yaml"));
		const tools = gen.toolsJson().tools;
		const charge = tools.find((t) => t.name === "createCharge")!;
		expect(charge.bodyContentType).toBe("form");
		expect(charge.bodyMode).toBe("fields");
		const raw = tools.find((t) => t.name === "submitRaw")!;
		expect(raw.bodyParams).toEqual([["body", "*"]]);
		const search = tools.find((t) => t.name === "search")!;
		expect(search.queryParams).toEqual([["locale", "locale"]]);
		const update = tools.find((t) => t.name === "updateItem")!;
		expect(update.bodyParams).toContainEqual(["body_id", "id"]);
	});
});
