import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { parseSpec } from "../src/parser/index.js";
import { mapToMcpTools } from "../src/mapper/index.js";
import { generate } from "../src/generator/index.js";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const fixture = resolve(import.meta.dir, "fixtures/petstore.yaml");

describe("generate", () => {
	let outputDir: string;

	beforeEach(() => {
		outputDir = mkdtempSync(join(tmpdir(), "openapi-to-mcp-test-"));
	});

	afterEach(() => {
		if (existsSync(outputDir)) {
			rmSync(outputDir, { recursive: true });
		}
	});

	test("creates all expected files", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools,
			spec,
			outputDir,
			serverName: "Test Server",
			transport: "stdio",
			auth: "none",
		});

		expect(existsSync(join(outputDir, "src/server.ts"))).toBe(true);
		expect(existsSync(join(outputDir, "package.json"))).toBe(true);
		expect(existsSync(join(outputDir, "tsconfig.json"))).toBe(true);
		expect(existsSync(join(outputDir, ".env.example"))).toBe(true);
	});

	test("generated server.ts contains all tools", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools,
			spec,
			outputDir,
			serverName: "Petstore",
			transport: "stdio",
			auth: "none",
		});

		const code = readFileSync(join(outputDir, "src/server.ts"), "utf-8");
		expect(code).toContain('"listPets"');
		expect(code).toContain('"createPet"');
		expect(code).toContain('"getPet"');
		expect(code).toContain('"deletePet"');
		expect(code).toContain("McpServer");
		expect(code).toContain("StdioServerTransport");
		expect(code).toContain('import { z } from "zod"');
	});

	test("generated package.json has correct name and deps", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools,
			spec,
			outputDir,
			serverName: "My Test API",
			transport: "stdio",
			auth: "none",
		});

		const pkg = JSON.parse(readFileSync(join(outputDir, "package.json"), "utf-8"));
		expect(pkg.name).toBe("my-test-api");
		expect(pkg.dependencies["@modelcontextprotocol/sdk"]).toBeDefined();
		expect(pkg.dependencies.zod).toBeDefined();
	});

	test("api-key auth uses correct header from spec", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools,
			spec,
			outputDir,
			serverName: "Test",
			transport: "stdio",
			auth: "api-key",
		});

		const code = readFileSync(join(outputDir, "src/server.ts"), "utf-8");
		expect(code).toContain("X-API-Key");
		expect(code).toContain("API_KEY");
	});

	test("bearer auth mode", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools,
			spec,
			outputDir,
			serverName: "Test",
			transport: "stdio",
			auth: "bearer",
		});

		const code = readFileSync(join(outputDir, "src/server.ts"), "utf-8");
		expect(code).toContain("API_TOKEN");
		expect(code).toContain("Bearer");
	});

	test("oauth2 auth mode", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools,
			spec,
			outputDir,
			serverName: "Test",
			transport: "stdio",
			auth: "oauth2",
		});

		const code = readFileSync(join(outputDir, "src/server.ts"), "utf-8");
		expect(code).toContain("OAUTH_CLIENT_ID");
		expect(code).toContain("OAUTH_CLIENT_SECRET");
		expect(code).toContain("OAUTH_TOKEN_URL");
		expect(code).toContain("client_credentials");
	});

	test(".env.example has correct vars for api-key", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools,
			spec,
			outputDir,
			serverName: "Test",
			transport: "stdio",
			auth: "api-key",
		});

		const env = readFileSync(join(outputDir, ".env.example"), "utf-8");
		expect(env).toContain("API_BASE_URL=https://petstore.example.com/v1");
		expect(env).toContain("API_KEY=");
	});

	test("server name is slugified in package.json", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools,
			spec,
			outputDir,
			serverName: "My Fancy API v2.0!",
			transport: "stdio",
			auth: "none",
		});

		const pkg = JSON.parse(readFileSync(join(outputDir, "package.json"), "utf-8"));
		expect(pkg.name).toBe("my-fancy-api-v2-0");
	});
});
