#!/usr/bin/env node

import { Command } from "commander";
import { resolve } from "node:path";
import { generate } from "./generator/index.js";
import { GENERATOR_VERSION } from "./generator/util.js";
import { parseSpec } from "./parser/index.js";
import { detectAuth, extractWebhooks, mapToMcpTools } from "./mapper/index.js";
import { PROFILES } from "./schema/adapt.js";
import { CLIENT_TARGETS, type AuthMode, type ClientTarget } from "./types.js";

const AUTH_MODES: AuthMode[] = ["none", "api-key", "bearer", "basic", "oauth2", "oauth2-auth-code"];

const program = new Command();

program
	.name("openapi-mcp-codegen")
	.description("Generate MCP servers from OpenAPI 3.x and Swagger 2.0 specifications")
	.version(GENERATOR_VERSION);

program
	.command("generate")
	.description("Generate an MCP server from an OpenAPI spec")
	.requiredOption("-i, --input <path>", "Path or URL to OpenAPI spec (YAML or JSON)")
	.option("-o, --output <dir>", "Output directory", "./mcp-server")
	.option("-n, --name <name>", "Server name (defaults to spec title)")
	.option("--transport <type>", "Transport: stdio | streamable-http", "stdio")
	.option("--auth <type>", `Auth: ${AUTH_MODES.join(" | ")} (default: auto-detect from spec)`)
	.option("--target <client>", `Adapt tool schemas to a client: ${CLIENT_TARGETS.join(" | ")}`, "generic")
	.option("--include-tags <tags>", "Only include operations with these tags (comma-separated)")
	.option("--exclude-tags <tags>", "Exclude operations with these tags (comma-separated)")
	.option("--exclude-deprecated", "Skip operations marked deprecated")
	.option("--no-webhooks", "Do not generate webhook receiver and tools")
	.option("--dry-run", "Print tool definitions without generating files")
	.action(async (opts) => {
		try {
			const target = opts.target as ClientTarget;
			if (!CLIENT_TARGETS.includes(target)) {
				throw new Error(`Unknown --target '${opts.target}'. Use one of: ${CLIENT_TARGETS.join(", ")}`);
			}
			if (opts.auth && !AUTH_MODES.includes(opts.auth)) {
				throw new Error(`Unknown --auth '${opts.auth}'. Use one of: ${AUTH_MODES.join(", ")}`);
			}
			if (opts.transport !== "stdio" && opts.transport !== "streamable-http") {
				throw new Error(`Unknown --transport '${opts.transport}'. Use stdio or streamable-http`);
			}
			const spec = await parseSpec(opts.input);
			const serverName = opts.name ?? spec.info.title;
			const tools = mapToMcpTools(spec, {
				serverName,
				target,
				includeTags: opts.includeTags?.split(",").map((t: string) => t.trim()),
				excludeTags: opts.excludeTags?.split(",").map((t: string) => t.trim()),
				excludeDeprecated: opts.excludeDeprecated,
			});
			const webhooks = opts.webhooks === false ? [] : extractWebhooks(spec);

			if (opts.dryRun) {
				console.log(JSON.stringify({ tools, webhooks }, null, 2));
				return;
			}

			const outputDir = resolve(opts.output);
			const auth: AuthMode = opts.auth ?? detectAuth(spec);
			await generate({ tools, spec, outputDir, serverName, transport: opts.transport, auth, webhooks, target });

			console.log(`MCP server generated at ${outputDir}`);
			console.log(`  ${tools.length} tools, auth: ${auth}, target: ${target}${webhooks.length ? `, ${webhooks.length} webhook events` : ""}`);
			const max = PROFILES[target].maxTools;
			if (max !== null && tools.length > max) {
				console.warn(
					`  Warning: ${tools.length} tools exceeds the ${target} limit of ${max}. Narrow with --include-tags, or set MCP_TOOLS_INCLUDE at runtime.`,
				);
			} else if (tools.length > 128) {
				console.warn(
					`  Note: ${tools.length} tools is a lot for most clients. Consider --include-tags or MCP_TOOLS_INCLUDE / MCP_READ_ONLY at runtime.`,
				);
			}
			console.log(`  cd ${opts.output} && npm install && npm run build && npm start`);
		} catch (err) {
			console.error(`Error: ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	});

program.parse();
