import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { parseSpec } from "../src/parser/index.js";
import { mapToMcpTools } from "../src/mapper/index.js";
import { generate } from "../src/generator/index.js";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

describe("paginated tool generation", () => {
	let outputDir: string;
	const fixture = resolve(import.meta.dir, "fixtures/paginated-api.yaml");

	beforeEach(() => {
		outputDir = mkdtempSync(join(tmpdir(), "openapi-to-mcp-pg-"));
	});

	afterEach(() => {
		if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
	});

	test("generates encodeCursor/decodeCursor helpers", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools, spec, outputDir,
			serverName: "Test", transport: "stdio", auth: "none",
		});

		const code = readFileSync(join(outputDir, "src/server.ts"), "utf-8");
		expect(code).toContain("encodeCursor");
		expect(code).toContain("decodeCursor");
		expect(code).toContain("base64url");
	});

	test("paginated tool uses offset logic", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools, spec, outputDir,
			serverName: "Test", transport: "stdio", auth: "none",
		});

		const code = readFileSync(join(outputDir, "src/server.ts"), "utf-8");
		// listItems uses offset pagination
		expect(code).toContain("has_more");
		expect(code).toContain("next_cursor");
	});

	test("non-paginated tools don't have cursor helpers", async () => {
		const spec = await parseSpec(resolve(import.meta.dir, "fixtures/petstore.yaml"));
		const tools = mapToMcpTools(spec);
		await generate({
			tools, spec, outputDir,
			serverName: "Test", transport: "stdio", auth: "none",
		});

		const code = readFileSync(join(outputDir, "src/server.ts"), "utf-8");
		expect(code).not.toContain("encodeCursor");
	});
});

describe("streaming tool generation", () => {
	let outputDir: string;
	const fixture = resolve(import.meta.dir, "fixtures/streaming-api.yaml");

	beforeEach(() => {
		outputDir = mkdtempSync(join(tmpdir(), "openapi-to-mcp-stream-"));
	});

	afterEach(() => {
		if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
	});

	test("generates streaming handler with reader", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools, spec, outputDir,
			serverName: "Test", transport: "stdio", auth: "none",
		});

		const code = readFileSync(join(outputDir, "src/server.ts"), "utf-8");
		expect(code).toContain("getReader");
		expect(code).toContain("TextDecoder");
		expect(code).toContain("(streaming)");
	});
});

describe("streamable HTTP transport generation", () => {
	let outputDir: string;
	const fixture = resolve(import.meta.dir, "fixtures/petstore.yaml");

	beforeEach(() => {
		outputDir = mkdtempSync(join(tmpdir(), "openapi-to-mcp-http-"));
	});

	afterEach(() => {
		if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
	});

	test("generates HTTP server with /mcp endpoint", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools, spec, outputDir,
			serverName: "HTTP Test", transport: "streamable-http", auth: "none",
		});

		const code = readFileSync(join(outputDir, "src/server.ts"), "utf-8");
		expect(code).toContain("StreamableHTTPServerTransport");
		expect(code).toContain('"/mcp"');
		expect(code).toContain("createServer");
		expect(code).not.toContain("StdioServerTransport");
	});
});
