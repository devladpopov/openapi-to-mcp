import type { GenerateOptions, McpToolDefinition } from "../types.js";

export function renderServerCode(opts: GenerateOptions): string {
	const imports = buildImports(opts);
	const toolRegistrations = opts.tools.map(renderToolHandler).join("\n\n");
	const serverSetup = buildServerSetup(opts);

	return `${imports}

const server = new McpServer({
	name: ${JSON.stringify(opts.serverName)},
	version: "0.1.0",
});

const API_BASE_URL = process.env.API_BASE_URL ?? ${JSON.stringify(opts.spec.servers?.[0]?.url ?? "")};

${renderAuthHelper(opts)}

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
	return `// TODO: Streamable HTTP transport setup
console.log("Streamable HTTP transport is not yet implemented");`;
}

function buildImports(opts: GenerateOptions): string {
	const lines = [
		`import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`,
	];

	if (opts.transport === "stdio") {
		lines.push(
			`import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";`,
		);
	}

	lines.push(`import { z } from "zod";`);

	return lines.join("\n");
}

function renderAuthHelper(opts: GenerateOptions): string {
	if (opts.auth === "none") {
		return `function authHeaders(): Record<string, string> {
	return {};
}`;
	}
	if (opts.auth === "api-key") {
		return `function authHeaders(): Record<string, string> {
	const key = process.env.API_KEY;
	if (!key) throw new Error("API_KEY environment variable is required");
	return { "Authorization": \`Bearer \${key}\` };
}`;
	}
	if (opts.auth === "bearer") {
		return `function authHeaders(): Record<string, string> {
	const token = process.env.API_TOKEN;
	if (!token) throw new Error("API_TOKEN environment variable is required");
	return { "Authorization": \`Bearer \${token}\` };
}`;
	}
	// oauth2
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

function renderToolHandler(tool: McpToolDefinition): string {
	const zodSchema = jsonSchemaToZod(tool.inputSchema);
	const isOAuth = tool.meta.auth?.type === "oauth2";
	const authCall = isOAuth ? "await authHeaders()" : "authHeaders()";

	const pathInterpolation = tool.meta.path.replace(
		/\{(\w+)\}/g,
		"${params.$1}",
	);

	const hasBody = ["POST", "PUT", "PATCH"].includes(tool.meta.method);

	return `server.tool(
	${JSON.stringify(tool.name)},
	${JSON.stringify(tool.description)},
	${zodSchema},
	async ({ ${hasBody ? "" : ""}params }) => {
		const url = \`\${API_BASE_URL}${pathInterpolation}\`${renderQueryString(tool)};
		const headers = { ...${authCall}, "Content-Type": "application/json" };
		const res = await fetch(url, {
			method: ${JSON.stringify(tool.meta.method)},
			headers,${hasBody ? '\n\t\t\tbody: JSON.stringify(params),' : ""}
		});
		const data = await res.text();
		return {
			content: [{ type: "text" as const, text: data }],
		};
	},
);`;
}

function renderQueryString(tool: McpToolDefinition): string {
	const queryParams = Object.entries(tool.inputSchema.properties ?? {}).filter(([name]) => {
		// Path params are in the URL template, body params go in body
		return !tool.meta.path.includes(`{${name}}`);
	});

	if (queryParams.length === 0 || ["POST", "PUT", "PATCH"].includes(tool.meta.method)) {
		return "";
	}

	return ` + "?" + new URLSearchParams(
			Object.entries(params)
				.filter(([k]) => !${JSON.stringify(tool.meta.path)}.includes(\`{\${k}}\`))
				.filter(([, v]) => v !== undefined)
				.map(([k, v]) => [k, String(v)])
		).toString()`;
}

function jsonSchemaToZod(schema: McpToolDefinition["inputSchema"]): string {
	const entries = Object.entries(schema.properties ?? {});
	if (entries.length === 0) return "{}";

	const fields = entries.map(([name, prop]) => {
		let zodType = schemaToZodType(prop);
		if (!schema.required?.includes(name)) {
			zodType += ".optional()";
		}
		if (prop.description) {
			zodType += `.describe(${JSON.stringify(prop.description)})`;
		}
		return `\t\t${name}: ${zodType},`;
	});

	return `{\n${fields.join("\n")}\n\t}`;
}

function schemaToZodType(schema: { type?: string; enum?: unknown[]; items?: { type?: string } }): string {
	if (schema.enum) {
		const values = schema.enum.map((v) => JSON.stringify(v));
		return `z.enum([${values.join(", ")}])`;
	}
	switch (schema.type) {
		case "integer":
		case "number":
			return "z.number()";
		case "boolean":
			return "z.boolean()";
		case "array":
			return `z.array(${schemaToZodType(schema.items ?? { type: "string" })})`;
		case "object":
			return "z.record(z.unknown())";
		default:
			return "z.string()";
	}
}
