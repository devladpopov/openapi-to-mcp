import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { parseSpec } from "../src/parser/index.js";
import { mapToMcpTools } from "../src/mapper/index.js";
import { generate } from "../src/generator/index.js";
import { resolve, join } from "node:path";
import { existsSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const fixture = resolve(import.meta.dir, "fixtures/oauth2-api.yaml");

describe("OAuth2 support", () => {
	test("detects OAuth2 auth from spec", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);

		// getProfile should have oauth2 auth from global security
		const getProfile = tools.find((t) => t.name === "getProfile")!;
		expect(getProfile.meta.auth).not.toBeNull();
		expect(getProfile.meta.auth!.type).toBe("oauth2");
	});

	test("operation with empty security has no auth", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);

		const getPublic = tools.find((t) => t.name === "getPublicData")!;
		expect(getPublic.meta.auth).toBeNull();
	});

	test("OAuth2 flows preserved in security scheme", async () => {
		const spec = await parseSpec(fixture);
		expect(spec.components!.securitySchemes!.oauth2.flows!.authorizationCode.authorizationUrl)
			.toBe("https://auth.example.com/authorize");
		expect(spec.components!.securitySchemes!.oauth2.flows!.authorizationCode.tokenUrl)
			.toBe("https://auth.example.com/token");
	});
});

describe("OAuth2 auth-code generation", () => {
	let outputDir: string;

	beforeEach(() => {
		outputDir = mkdtempSync(join(tmpdir(), "openapi-to-mcp-oauth-"));
	});

	afterEach(() => {
		if (existsSync(outputDir)) rmSync(outputDir, { recursive: true });
	});

	test("generates OAuth2 auth code helper with PKCE", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools,
			spec,
			outputDir,
			serverName: "OAuth Test",
			transport: "stdio",
			auth: "oauth2-auth-code",
		});

		const code = readFileSync(join(outputDir, "src/server.ts"), "utf-8");
		expect(code).toContain("generatePKCE");
		expect(code).toContain("code_challenge");
		expect(code).toContain("code_verifier");
		expect(code).toContain("authorization_code");
		expect(code).toContain("refresh_token");
		expect(code).toContain("OAUTH_AUTH_URL");
		expect(code).toContain("OAUTH_CLIENT_ID");
	});

	test("generates OAuth2 CC helper for client_credentials", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools,
			spec,
			outputDir,
			serverName: "OAuth CC Test",
			transport: "stdio",
			auth: "oauth2",
		});

		const code = readFileSync(join(outputDir, "src/server.ts"), "utf-8");
		expect(code).toContain("client_credentials");
		expect(code).toContain("OAUTH_TOKEN_URL");
		expect(code).not.toContain("generatePKCE");
	});

	test(".env.example has auth-code vars", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools,
			spec,
			outputDir,
			serverName: "Test",
			transport: "stdio",
			auth: "oauth2-auth-code",
		});

		const env = readFileSync(join(outputDir, ".env.example"), "utf-8");
		expect(env).toContain("OAUTH_AUTH_URL=");
		expect(env).toContain("OAUTH_TOKEN_URL=");
		expect(env).toContain("OAUTH_SCOPES=");
		expect(env).toContain("OAUTH_REDIRECT_PORT=");
	});

	test("auth-code helper reads URLs from spec flows", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		await generate({
			tools,
			spec,
			outputDir,
			serverName: "Test",
			transport: "stdio",
			auth: "oauth2-auth-code",
		});

		const code = readFileSync(join(outputDir, "src/server.ts"), "utf-8");
		expect(code).toContain("https://auth.example.com/authorize");
		expect(code).toContain("https://auth.example.com/token");
	});
});
