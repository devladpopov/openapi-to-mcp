import { afterEach, describe, expect, test } from "bun:test";
import { parseSpec } from "../src/parser/index.js";
import { detectAuth, mapToMcpTools } from "../src/mapper/index.js";
import { type Generated, generateFixture } from "./helpers.js";
import { resolve } from "node:path";

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

describe("OAuth2 generation", () => {
	let gen: Generated | undefined;
	afterEach(() => {
		gen?.cleanup();
		gen = undefined;
	});

	test("auth-code config carries URLs and scopes from spec flows", async () => {
		gen = await generateFixture(fixture, { auth: "oauth2-auth-code" });
		const config = gen.config();
		expect(config).toContain('"mode": "oauth2-auth-code"');
		expect(config).toContain("https://auth.example.com/authorize");
		expect(config).toContain("https://auth.example.com/token");
		const auth = gen.file("src/auth.ts");
		for (const s of ["generatePKCE", "code_challenge", "code_verifier", "authorization_code", "refresh_token", "OAUTH_AUTH_URL"]) {
			expect(auth).toContain(s);
		}
	});

	test(".env.example has auth-code vars", async () => {
		gen = await generateFixture(fixture, { auth: "oauth2-auth-code" });
		const env = gen.file(".env.example");
		expect(env).toContain("OAUTH_AUTH_URL=");
		expect(env).toContain("OAUTH_TOKEN_URL=");
		expect(env).toContain("OAUTH_SCOPES=");
		expect(env).toContain("OAUTH_REDIRECT_PORT=");
	});

	test("client credentials config", async () => {
		gen = await generateFixture(fixture, { auth: "oauth2" });
		expect(gen.config()).toContain('"mode": "oauth2"');
		expect(gen.file(".env.example")).toContain("OAUTH_TOKEN_URL=");
	});

	test("detectAuth prefers authorization code flow", async () => {
		const spec = await parseSpec(fixture);
		expect(detectAuth(spec)).toBe("oauth2-auth-code");
	});
});
