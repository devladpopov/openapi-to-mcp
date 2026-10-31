import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GenerateOptions, McpToolDefinition } from "../types.js";
import { RUNTIME_FILES } from "./runtime-sources.js";
import { renderConfig, renderEnvExample, renderReadme } from "./templates.js";
import { GENERATOR_VERSION, slugify } from "./util.js";

export { GENERATOR_VERSION };

/**
 * Write a self-contained MCP server project:
 *
 *   tools.json       tool definitions (data, editable)
 *   src/config.ts    server name, base URL, auth mode
 *   src/*.ts         fixed runtime (request building, auth, validation, webhooks)
 */
export async function generate(opts: GenerateOptions): Promise<void> {
	mkdirSync(join(opts.outputDir, "src"), { recursive: true });

	for (const [name, text] of Object.entries(RUNTIME_FILES)) {
		writeFileSync(join(opts.outputDir, "src", name), text);
	}
	writeFileSync(join(opts.outputDir, "src", "config.ts"), renderConfig(opts));
	writeFileSync(join(opts.outputDir, "tools.json"), renderToolsJson(opts));

	writeFileSync(
		join(opts.outputDir, "package.json"),
		`${JSON.stringify(
			{
				name: slugify(opts.serverName) || "mcp-server",
				version: "0.1.0",
				description: `MCP server for ${opts.spec.info?.title ?? opts.serverName}`,
				type: "module",
				bin: { [slugify(opts.serverName) || "mcp-server"]: "dist/server.js" },
				files: ["dist/", "tools.json"],
				scripts: {
					build: "tsc",
					start: "node dist/server.js",
				},
				engines: { node: ">=20.3.0" },
				dependencies: {
					"@modelcontextprotocol/sdk": "^1.29.0",
					zod: "^3.25.0",
				},
				devDependencies: {
					typescript: "^5.7.0",
					"@types/node": "^22.0.0",
				},
			},
			null,
			2,
		)}\n`,
	);

	writeFileSync(
		join(opts.outputDir, "tsconfig.json"),
		`${JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "Node16",
					moduleResolution: "Node16",
					lib: ["ES2022", "DOM"],
					outDir: "dist",
					rootDir: "src",
					strict: true,
					esModuleInterop: true,
					skipLibCheck: true,
				},
				include: ["src/**/*"],
			},
			null,
			2,
		)}\n`,
	);

	writeFileSync(join(opts.outputDir, ".env.example"), renderEnvExample(opts));
	writeFileSync(join(opts.outputDir, "README.md"), renderReadme(opts));
	writeFileSync(join(opts.outputDir, ".gitignore"), "node_modules/\ndist/\n.env\n");
}

function renderToolsJson(opts: GenerateOptions): string {
	const data = {
		generator: `openapi-mcp-codegen@${GENERATOR_VERSION}`,
		target: opts.target ?? "generic",
		tools: opts.tools.map(toToolSpec),
		webhooks: opts.webhooks ?? [],
	};
	return `${JSON.stringify(data, null, 1)}\n`;
}

/** Flatten a tool definition into the runtime's ToolSpec shape (src/runtime/types.ts). */
export function toToolSpec(t: McpToolDefinition): Record<string, unknown> {
	const m = t.meta;
	const spec: Record<string, unknown> = {
		name: t.name,
		title: t.title,
		description: t.description,
		inputSchema: t.inputSchema,
		annotations: t.annotations,
		method: m.method,
		path: m.path,
		tags: m.tags.length ? m.tags : undefined,
		pathParams: m.pathParams,
		queryParams: m.queryParams,
		headerParams: m.headerParams,
		bodyParams: m.bodyParams,
		bodyMode: m.bodyMode,
		bodyContentType: m.bodyContentType,
		bodyMediaType: m.bodyMediaType,
		pagination: m.pagination ?? undefined,
		streaming: m.streaming || undefined,
		requiresAuth: m.requiresAuth ? undefined : false,
		jsonArgs: m.jsonArgs,
		looseArgs: m.looseArgs,
		jsonAnyArgs: m.jsonAnyArgs,
		queryStyles: m.queryStyles,
		baseUrl: m.baseUrl,
	};
	for (const k of Object.keys(spec)) if (spec[k] === undefined) delete spec[k];
	return spec;
}
