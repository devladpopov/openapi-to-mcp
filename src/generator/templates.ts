import type { GenerateOptions, JsonSchema, McpToolDefinition, AuthMode } from "../types.js";

export function renderServerCode(opts: GenerateOptions): string {
	const imports = buildImports(opts);
	const toolRegistrations = opts.tools.map((t) => renderToolHandler(t, opts.auth)).join("\n\n");
	const serverSetup = buildServerSetup(opts);

	return `${imports}

const server = new McpServer({
	name: ${JSON.stringify(opts.serverName)},
	version: "0.1.0",
});

const API_BASE_URL = process.env.API_BASE_URL ?? ${JSON.stringify(opts.spec.servers?.[0]?.url ?? "")};

${renderAuthHelper(opts)}

${renderPaginationHelper(opts)}

${renderRequestHelpers(opts)}

${toolRegistrations}

${serverSetup}
`;
}

function buildServerSetup(opts: GenerateOptions): string {
	if (opts.transport === "stdio") {
		return `async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch(console.error);`;
	}
	// Streamable HTTP
	return `const PORT = parseInt(process.env.PORT ?? "3000", 10);

async function main() {
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	await server.connect(transport);

	const httpServer = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", \`http://\${req.headers.host}\`);
		if (url.pathname === "/mcp") {
			try {
				await transport.handleRequest(req, res);
			} catch (err) {
				console.error("Error handling MCP request:", err);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
				}
			}
		} else {
			res.writeHead(404);
			res.end("Not found");
		}
	});

	httpServer.listen(PORT, () => {
		console.log(\`MCP server listening on http://localhost:\${PORT}/mcp\`);
	});
}

main().catch(console.error);`;
}

function buildImports(opts: GenerateOptions): string {
	const lines = [
		`import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`,
	];

	if (opts.transport === "stdio") {
		lines.push(
			`import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";`,
		);
	} else {
		lines.push(
			`import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";`,
			`import { createServer } from "node:http";`,
		);
	}

	lines.push(`import { z } from "zod";`);

	if (opts.auth === "oauth2-auth-code") {
		lines.push(
			`import { createServer as createHttpServer } from "node:http";`,
			`import { randomBytes, createHash } from "node:crypto";`,
		);
	}

	return lines.join("\n");
}

function renderAuthHelper(opts: GenerateOptions): string {
	if (opts.auth === "none") {
		return `function authHeaders(): Record<string, string> {
	return {};
}`;
	}
	if (opts.auth === "api-key") {
		const apiKeyScheme = Object.values(opts.spec.components?.securitySchemes ?? {})
			.find((s) => s.type === "apiKey");
		const headerName = apiKeyScheme?.name ?? "X-API-Key";
		return `function authHeaders(): Record<string, string> {
	const key = process.env.API_KEY;
	if (!key) throw new Error("API_KEY environment variable is required");
	return { ${JSON.stringify(headerName)}: key };
}`;
	}
	if (opts.auth === "bearer") {
		return `function authHeaders(): Record<string, string> {
	const token = process.env.API_TOKEN;
	if (!token) throw new Error("API_TOKEN environment variable is required");
	return { "Authorization": \`Bearer \${token}\` };
}`;
	}
	if (opts.auth === "oauth2-auth-code") {
		return renderOAuth2AuthCodeHelper(opts);
	}
	// oauth2 (client credentials)
	return renderOAuth2CCHelper();
}

function renderOAuth2CCHelper(): string {
	return `let cachedToken: { token: string; expiresAt: number } | null = null;

async function getOAuthToken(): Promise<string> {
	if (cachedToken && Date.now() < cachedToken.expiresAt) {
		return cachedToken.token;
	}
	const tokenUrl = process.env.OAUTH_TOKEN_URL;
	const clientId = process.env.OAUTH_CLIENT_ID;
	const clientSecret = process.env.OAUTH_CLIENT_SECRET;
	if (!tokenUrl || !clientId || !clientSecret) {
		throw new Error("OAUTH_TOKEN_URL, OAUTH_CLIENT_ID, and OAUTH_CLIENT_SECRET are required");
	}
	const res = await fetch(tokenUrl, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "client_credentials",
			client_id: clientId,
			client_secret: clientSecret,
		}),
	});
	if (!res.ok) throw new Error(\`OAuth token request failed: \${res.status}\`);
	const data = await res.json() as { access_token: string; expires_in?: number };
	cachedToken = {
		token: data.access_token,
		expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
	};
	return cachedToken.token;
}

async function authHeaders(): Promise<Record<string, string>> {
	const token = await getOAuthToken();
	return { "Authorization": \`Bearer \${token}\` };
}`;
}

function renderOAuth2AuthCodeHelper(opts: GenerateOptions): string {
	// Extract OAuth2 flow details from spec
	const oauthScheme = Object.values(opts.spec.components?.securitySchemes ?? {})
		.find((s) => s.type === "oauth2");
	const flow = oauthScheme?.flows?.authorizationCode;
	const defaultAuthUrl = flow?.authorizationUrl ?? "";
	const defaultTokenUrl = flow?.tokenUrl ?? "";
	const defaultScopes = Object.keys(flow?.scopes ?? {}).join(" ");

	return `interface TokenStore {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
}

let tokenStore: TokenStore | null = null;

const OAUTH_AUTH_URL = process.env.OAUTH_AUTH_URL ?? ${JSON.stringify(defaultAuthUrl)};
const OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL ?? ${JSON.stringify(defaultTokenUrl)};
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? "";
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET ?? "";
const OAUTH_REDIRECT_PORT = parseInt(process.env.OAUTH_REDIRECT_PORT ?? "8976", 10);
const OAUTH_REDIRECT_URI = \`http://localhost:\${OAUTH_REDIRECT_PORT}/callback\`;
const OAUTH_SCOPES = process.env.OAUTH_SCOPES ?? ${JSON.stringify(defaultScopes)};

function generatePKCE(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

async function refreshAccessToken(): Promise<string> {
	if (!tokenStore?.refreshToken) throw new Error("No refresh token available");
	const res = await fetch(OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: tokenStore.refreshToken,
			client_id: OAUTH_CLIENT_ID,
			...(OAUTH_CLIENT_SECRET ? { client_secret: OAUTH_CLIENT_SECRET } : {}),
		}),
	});
	if (!res.ok) {
		tokenStore = null;
		throw new Error(\`Token refresh failed: \${res.status}\`);
	}
	const data = await res.json() as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};
	tokenStore = {
		accessToken: data.access_token,
		refreshToken: data.refresh_token ?? tokenStore.refreshToken,
		expiresAt: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000,
	};
	return tokenStore.accessToken;
}

async function authorizeInteractive(): Promise<string> {
	if (!OAUTH_CLIENT_ID) throw new Error("OAUTH_CLIENT_ID is required");
	if (!OAUTH_AUTH_URL || !OAUTH_TOKEN_URL) {
		throw new Error("OAUTH_AUTH_URL and OAUTH_TOKEN_URL are required");
	}

	const { verifier, challenge } = generatePKCE();
	const state = randomBytes(16).toString("hex");

	const authUrl = new URL(OAUTH_AUTH_URL);
	authUrl.searchParams.set("response_type", "code");
	authUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
	authUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
	authUrl.searchParams.set("state", state);
	authUrl.searchParams.set("code_challenge", challenge);
	authUrl.searchParams.set("code_challenge_method", "S256");
	if (OAUTH_SCOPES) authUrl.searchParams.set("scope", OAUTH_SCOPES);

	console.error(\`\\nOpen this URL to authorize:\\n\${authUrl.toString()}\\n\`);

	const code = await new Promise<string>((resolve, reject) => {
		const srv = createHttpServer((req, res) => {
			const url = new URL(req.url ?? "/", \`http://localhost:\${OAUTH_REDIRECT_PORT}\`);
			if (url.pathname !== "/callback") {
				res.writeHead(404);
				res.end();
				return;
			}
			const receivedState = url.searchParams.get("state");
			const receivedCode = url.searchParams.get("code");
			const error = url.searchParams.get("error");

			if (error) {
				res.writeHead(400);
				res.end(\`Authorization error: \${error}\`);
				srv.close();
				reject(new Error(\`OAuth error: \${error}\`));
				return;
			}
			if (receivedState !== state || !receivedCode) {
				res.writeHead(400);
				res.end("Invalid callback");
				srv.close();
				reject(new Error("Invalid OAuth callback"));
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html" });
			res.end("<h1>Authorization successful!</h1><p>You can close this tab.</p>");
			srv.close();
			resolve(receivedCode);
		});

		srv.listen(OAUTH_REDIRECT_PORT, () => {
			console.error(\`Waiting for OAuth callback on port \${OAUTH_REDIRECT_PORT}...\`);
		});

		setTimeout(() => {
			srv.close();
			reject(new Error("OAuth callback timed out after 120 seconds"));
		}, 120_000);
	});

	const tokenRes = await fetch(OAUTH_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: OAUTH_REDIRECT_URI,
			client_id: OAUTH_CLIENT_ID,
			code_verifier: verifier,
			...(OAUTH_CLIENT_SECRET ? { client_secret: OAUTH_CLIENT_SECRET } : {}),
		}),
	});
	if (!tokenRes.ok) throw new Error(\`Token exchange failed: \${tokenRes.status}\`);

	const tokenData = await tokenRes.json() as {
		access_token: string;
		refresh_token?: string;
		expires_in?: number;
	};
	tokenStore = {
		accessToken: tokenData.access_token,
		refreshToken: tokenData.refresh_token,
		expiresAt: Date.now() + ((tokenData.expires_in ?? 3600) - 60) * 1000,
	};
	return tokenStore.accessToken;
}

async function authHeaders(): Promise<Record<string, string>> {
	if (tokenStore && Date.now() < tokenStore.expiresAt) {
		return { "Authorization": \`Bearer \${tokenStore.accessToken}\` };
	}
	if (tokenStore?.refreshToken) {
		try {
			const token = await refreshAccessToken();
			return { "Authorization": \`Bearer \${token}\` };
		} catch {
			// Refresh failed, re-authorize
		}
	}
	const token = await authorizeInteractive();
	return { "Authorization": \`Bearer \${token}\` };
}`;
}

function renderPaginationHelper(opts: GenerateOptions): string {
	const hasPaginated = opts.tools.some((t) => t.meta.pagination);
	if (!hasPaginated) return "";

	return `// Pagination cursor encoding/decoding
function encodeCursor(data: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(data)).toString("base64url");
}

function decodeCursor(cursor: string): Record<string, unknown> {
	try {
		return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
	} catch {
		throw new Error("Invalid pagination cursor");
	}
}`;
}

function renderToolHandler(tool: McpToolDefinition, authMode: AuthMode): string {
	if (tool.meta.pagination) {
		return renderPaginatedToolHandler(tool, authMode);
	}
	if (tool.meta.streaming) {
		return renderStreamingToolHandler(tool, authMode);
	}
	return renderSimpleToolHandler(tool, authMode);
}

function renderSimpleToolHandler(tool: McpToolDefinition, authMode: AuthMode): string {
	const zodSchema = jsonSchemaToZod(tool.inputSchema);
	const authCall = isAsyncAuth(authMode) ? "await authHeaders()" : "authHeaders()";
	const pathInterpolation = interpolatePath(tool.meta.path);
	const query = tool.meta.queryParams.length
		? ` + buildQuery(p, ${JSON.stringify(tool.meta.queryParams)})`
		: "";
	const hasBody = tool.meta.bodyMode !== "none" && tool.meta.method !== "GET";
	const bodyLine = hasBody
		? `\n\t\t\tbody: JSON.stringify(pickBody(p, ${JSON.stringify(tool.meta.bodyParams)})),`
		: "";

	return `server.tool(
	${JSON.stringify(tool.name)},
	${JSON.stringify(tool.description)},
	${zodSchema},
	async (params) => {
		const p: Record<string, unknown> = params;
		const url = \`\${API_BASE_URL}${pathInterpolation}\`${query};
		const headers: Record<string, string> = { ...${authCall}, "Content-Type": "application/json" };
		const res = await fetch(url, {
			method: ${JSON.stringify(tool.meta.method)},
			headers,${bodyLine}
		});
		const data = await res.text();
		return {
			content: [{ type: "text" as const, text: data }],
		};
	},
);`;
}

function renderPaginatedToolHandler(tool: McpToolDefinition, authMode: AuthMode): string {
	const zodSchema = jsonSchemaToZod(tool.inputSchema);
	const authCall = isAsyncAuth(authMode) ? "await authHeaders()" : "authHeaders()";
	const pg = tool.meta.pagination!;
	const pathInterpolation = interpolatePath(tool.meta.path);
	const passThrough = JSON.stringify(tool.meta.queryParams);

	// Build the pagination param injection based on type
	let paginationLogic: string;
	if (pg.type === "offset") {
		paginationLogic = `\t\t// Decode cursor to get offset, or start from 0
		const pageLimit = typeof p.limit === "number" ? p.limit : ${pg.defaultLimit};
		let offset = 0;
		if (typeof p.cursor === "string") {
			const decoded = decodeCursor(p.cursor);
			offset = (decoded.offset as number) ?? 0;
		}
		const queryParams: Record<string, string> = {};
		for (const k of ${passThrough}) {
			const v = p[k];
			if (v !== undefined && v !== null) queryParams[k] = String(v);
		}
		queryParams[${JSON.stringify(pg.limitParam)}] = String(pageLimit);
		queryParams[${JSON.stringify(pg.offsetParam!)}] = String(offset);
		const qs = new URLSearchParams(queryParams).toString();
		const url = \`\${API_BASE_URL}${pathInterpolation}\` + (qs ? "?" + qs : "");`;
	} else if (pg.type === "page") {
		paginationLogic = `\t\t// Decode cursor to get page number, or start from 1
		const pageLimit = typeof p.limit === "number" ? p.limit : ${pg.defaultLimit};
		let page = 1;
		if (typeof p.cursor === "string") {
			const decoded = decodeCursor(p.cursor);
			page = (decoded.page as number) ?? 1;
		}
		const queryParams: Record<string, string> = {};
		for (const k of ${passThrough}) {
			const v = p[k];
			if (v !== undefined && v !== null) queryParams[k] = String(v);
		}
		queryParams[${JSON.stringify(pg.limitParam)}] = String(pageLimit);
		queryParams[${JSON.stringify(pg.pageParam!)}] = String(page);
		const qs = new URLSearchParams(queryParams).toString();
		const url = \`\${API_BASE_URL}${pathInterpolation}\` + (qs ? "?" + qs : "");`;
	} else {
		// cursor type: pass cursor directly
		paginationLogic = `\t\tconst pageLimit = typeof p.limit === "number" ? p.limit : ${pg.defaultLimit};
		const queryParams: Record<string, string> = {};
		for (const k of ${passThrough}) {
			const v = p[k];
			if (v !== undefined && v !== null) queryParams[k] = String(v);
		}
		queryParams[${JSON.stringify(pg.limitParam)}] = String(pageLimit);
		if (typeof p.cursor === "string") {
			const decoded = decodeCursor(p.cursor);
			queryParams[${JSON.stringify(pg.cursorParam ?? "cursor")}] = decoded.cursor as string;
		}
		const qs = new URLSearchParams(queryParams).toString();
		const url = \`\${API_BASE_URL}${pathInterpolation}\` + (qs ? "?" + qs : "");`;
	}

	// Build response wrapping logic
	let nextCursorLogic: string;
	if (pg.type === "offset") {
		nextCursorLogic = `\t\tconst nextOffset = offset + pageLimit;
		const total = parsed?.${pg.totalPath} as number | undefined;
		const hasMore = total !== undefined ? nextOffset < total : items.length >= pageLimit;
		const nextCursor = hasMore ? encodeCursor({ offset: nextOffset }) : null;`;
	} else if (pg.type === "page") {
		nextCursorLogic = `\t\tconst total = parsed?.${pg.totalPath} as number | undefined;
		const totalPages = total !== undefined ? Math.ceil(total / pageLimit) : undefined;
		const hasMore = totalPages !== undefined ? page < totalPages : items.length >= pageLimit;
		const nextCursor = hasMore ? encodeCursor({ page: page + 1 }) : null;`;
	} else {
		nextCursorLogic = `\t\tconst apiCursor = parsed?.${pg.cursorPath} as string | undefined;
		const hasMore = !!apiCursor;
		const nextCursor = hasMore ? encodeCursor({ cursor: apiCursor }) : null;`;
	}

	return `server.tool(
	${JSON.stringify(tool.name)},
	${JSON.stringify(tool.description)},
	${zodSchema},
	async (params) => {
		const p: Record<string, unknown> = params;
${paginationLogic}
		const headers: Record<string, string> = { ...${authCall}, "Content-Type": "application/json" };
		const res = await fetch(url, { method: "GET", headers });
		const data = await res.text();
		let parsed: Record<string, unknown> | null = null;
		try { parsed = JSON.parse(data); } catch {}
		const items = (parsed && Array.isArray(parsed.${pg.itemsPath}) ? parsed.${pg.itemsPath} : parsed) as unknown[];
${nextCursorLogic}
		const result = {
			items,
			has_more: hasMore,
			...(nextCursor ? { next_cursor: nextCursor } : {}),
			...(parsed?.${pg.totalPath} !== undefined ? { total: parsed.${pg.totalPath} } : {}),
		};
		return {
			content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
		};
	},
);`;
}

function renderStreamingToolHandler(tool: McpToolDefinition, authMode: AuthMode): string {
	const zodSchema = jsonSchemaToZod(tool.inputSchema);
	const authCall = isAsyncAuth(authMode) ? "await authHeaders()" : "authHeaders()";
	const pathInterpolation = interpolatePath(tool.meta.path);
	const query = tool.meta.queryParams.length
		? ` + buildQuery(p, ${JSON.stringify(tool.meta.queryParams)})`
		: "";

	return `server.tool(
	${JSON.stringify(tool.name)},
	${JSON.stringify(tool.description + " (streaming)")},
	${zodSchema},
	async (params) => {
		const p: Record<string, unknown> = params;
		const url = \`\${API_BASE_URL}${pathInterpolation}\`${query};
		const headers: Record<string, string> = { ...${authCall}, "Accept": "text/event-stream" };
		const res = await fetch(url, { method: ${JSON.stringify(tool.meta.method)}, headers });
		if (!res.body) {
			return { content: [{ type: "text" as const, text: "No response body" }] };
		}
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		const chunks: string[] = [];
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(decoder.decode(value, { stream: true }));
		}
		return {
			content: [{ type: "text" as const, text: chunks.join("") }],
		};
	},
);`;
}

function isAsyncAuth(authMode: AuthMode): boolean {
	return authMode === "oauth2" || authMode === "oauth2-auth-code";
}

/** Interpolate OpenAPI path template into a JS template literal using params. */
function interpolatePath(path: string): string {
	return path.replace(
		/\{([^}]+)\}/g,
		(_m, name: string) => `\${encodeURIComponent(String(p[${JSON.stringify(name)}] ?? ""))}`,
	);
}

/** Runtime helpers shared by all generated handlers; rendered once per server. */
function renderRequestHelpers(opts: GenerateOptions): string {
	const needsBody = opts.tools.some((t) => t.meta.bodyMode !== "none");
	const needsQuery = opts.tools.some((t) => t.meta.queryParams.length > 0 && !t.meta.pagination);

	const parts: string[] = [];
	if (needsQuery) {
		parts.push(`function buildQuery(params: Record<string, unknown>, keys: string[]): string {
	const entries: Array<[string, string]> = [];
	for (const k of keys) {
		const v = params[k];
		if (v === undefined || v === null) continue;
		entries.push([k, String(v)]);
	}
	return entries.length ? "?" + new URLSearchParams(entries).toString() : "";
}`);
	}
	if (needsBody) {
		parts.push(`function pickBody(params: Record<string, unknown>, pairs: string[][]): unknown {
	if (pairs.length === 1 && pairs[0][1] === "*") return params[pairs[0][0]];
	const out: Record<string, unknown> = {};
	for (const [propKey, fieldKey] of pairs) {
		if (params[propKey] !== undefined) out[fieldKey] = params[propKey];
	}
	return out;
}`);
	}
	return parts.join("\n\n");
}

const MAX_ZOD_DEPTH = 4;
const MAX_DESCRIBE_LENGTH = 300;

function jsonSchemaToZod(schema: McpToolDefinition["inputSchema"]): string {
	const entries = Object.entries(schema.properties ?? {});
	if (entries.length === 0) return "{}";

	const fields = entries.map(([name, prop]) => {
		let zodType = schemaToZodType(prop, 0);
		if (!schema.required?.includes(name)) {
			zodType += ".optional()";
		}
		if (prop.description) {
			zodType += `.describe(${JSON.stringify(truncate(prop.description, MAX_DESCRIBE_LENGTH))})`;
		}
		return `\t\t${JSON.stringify(name)}: ${zodType},`;
	});

	return `{\n${fields.join("\n")}\n\t}`;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

function schemaToZodType(schema: JsonSchema, depth: number): string {
	if (depth > MAX_ZOD_DEPTH) return "z.unknown()";
	let zod = baseZodType(schema, depth);
	const isNullable =
		schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes("null"));
	if (isNullable && zod !== "z.unknown()" && zod !== "z.null()") {
		zod += ".nullable()";
	}
	return zod;
}

function baseZodType(schema: JsonSchema, depth: number): string {
	if (schema.enum && schema.enum.length > 0) {
		const nonNull = schema.enum.filter((v) => v !== null);
		if (nonNull.length === 0) return "z.null()";
		if (nonNull.every((v) => typeof v === "string")) {
			return `z.enum([${nonNull.map((v) => JSON.stringify(v)).join(", ")}])`;
		}
		const literals = nonNull.map((v) => `z.literal(${JSON.stringify(v)})`);
		return literals.length === 1 ? literals[0] : `z.union([${literals.join(", ")}])`;
	}

	const variants = schema.oneOf ?? schema.anyOf;
	if (variants && variants.length > 0) {
		const subs = [
			...new Set(
				variants
					.filter((v) => v.type !== "null")
					.slice(0, 5)
					.map((v) => schemaToZodType(v, depth + 1)),
			),
		];
		if (subs.length === 0) return "z.unknown()";
		if (subs.length === 1) return subs[0];
		return `z.union([${subs.join(", ")}])`;
	}

	if (schema.allOf && schema.allOf.length > 0) {
		const merged: JsonSchema = { type: "object", properties: {}, required: [] };
		for (const part of schema.allOf) {
			if (part.properties) Object.assign(merged.properties!, part.properties);
			if (part.required) merged.required!.push(...part.required);
		}
		if (Object.keys(merged.properties!).length > 0) {
			return renderZodObject(merged, depth);
		}
		return "z.unknown()";
	}

	const type = Array.isArray(schema.type)
		? schema.type.find((t) => t !== "null")
		: schema.type;

	switch (type) {
		case "integer":
			return "z.number().int()";
		case "number":
			return "z.number()";
		case "boolean":
			return "z.boolean()";
		case "array":
			return `z.array(${schema.items ? schemaToZodType(schema.items, depth + 1) : "z.unknown()"})`;
		case "object":
			return renderZodObject(schema, depth);
		case "string":
			return "z.string()";
		default:
			if (schema.properties) return renderZodObject(schema, depth);
			return "z.string()";
	}
}

function renderZodObject(schema: JsonSchema, depth: number): string {
	const entries = Object.entries(schema.properties ?? {});
	if (entries.length === 0 || depth >= MAX_ZOD_DEPTH) {
		return "z.record(z.unknown())";
	}
	const fields = entries.map(([key, val]) => {
		let zod = schemaToZodType(val, depth + 1);
		if (!schema.required?.includes(key)) zod += ".optional()";
		return `${JSON.stringify(key)}: ${zod}`;
	});
	return `z.object({ ${fields.join(", ")} }).passthrough()`;
}
