#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generate } from "./generator/index.js";
import { parseSpec } from "./parser/index.js";
import { mapToMcpTools } from "./mapper/index.js";
import type { OpenApiSpec } from "./types.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

const program = new Command();

program
	.name("openapi-to-mcp")
	.description("Generate MCP servers from OpenAPI 3.x specifications")
	.version(pkg.version);

program
	.command("generate")
	.description("Generate an MCP server from an OpenAPI spec")
	.requiredOption("-i, --input <path>", "Path or URL to OpenAPI spec (YAML or JSON)")
	.option("-o, --output <dir>", "Output directory", "./mcp-server")
	.option("-n, --name <name>", "Server name (defaults to spec title)")
	.option("--transport <type>", "Transport: stdio | streamable-http", "stdio")
	.option("--auth <type>", "Auth: none | api-key | bearer | oauth2", "none")
	.option("--include-tags <tags>", "Only include operations with these tags (comma-separated)")
	.option("--exclude-tags <tags>", "Exclude operations with these tags (comma-separated)")
	.option("--dry-run", "Print tool definitions without generating files")
	.action(async (opts) => {
		try {
			const spec = await parseSpec(opts.input);
			const tools = mapToMcpTools(spec, {
				serverName: opts.name,
				includeTags: opts.includeTags?.split(",").map((t: string) => t.trim()),
				excludeTags: opts.excludeTags?.split(",").map((t: string) => t.trim()),
			});

			if (opts.dryRun) {
				console.log(JSON.stringify(tools, null, 2));
				return;
			}

			const outputDir = resolve(opts.output);
			const auth = opts.auth === "none" ? detectAuth(spec) : opts.auth;
			await generate({
				tools,
				spec,
				outputDir,
				serverName: opts.name ?? spec.info.title,
				transport: opts.transport,
				auth,
			});

			console.log(`MCP server generated at ${outputDir}`);
			console.log(`  cd ${opts.output} && npm install && npm start`);
		} catch (err) {
			console.error(`Error: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	});

function detectAuth(spec: OpenApiSpec): "none" | "api-key" | "bearer" | "oauth2" {
	const schemes = Object.values(spec.components?.securitySchemes ?? {});
	if (schemes.length === 0) return "none";
	const first = schemes[0];
	if (first.type === "apiKey") return "api-key";
	if (first.type === "http" && first.scheme === "bearer") return "bearer";
	if (first.type === "oauth2") return "oauth2";
	return "none";
}

program.parse();
