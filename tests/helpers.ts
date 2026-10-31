import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../src/generator/index.js";
import { extractWebhooks, mapToMcpTools } from "../src/mapper/index.js";
import { parseSpec } from "../src/parser/index.js";
import type { AuthMode, ClientTarget } from "../src/types.js";

export interface Generated {
	dir: string;
	file(rel: string): string;
	toolsJson(): {
		target: string;
		tools: Array<Record<string, any>>;
		webhooks: Array<Record<string, any>>;
	};
	config(): string;
	cleanup(): void;
}

export async function generateFixture(
	fixture: string,
	opts: { auth?: AuthMode; transport?: "stdio" | "streamable-http"; target?: ClientTarget; name?: string } = {},
): Promise<Generated> {
	const dir = mkdtempSync(join(tmpdir(), "openapi-to-mcp-gen-"));
	const spec = await parseSpec(fixture);
	const tools = mapToMcpTools(spec, { target: opts.target });
	await generate({
		tools,
		spec,
		outputDir: dir,
		serverName: opts.name ?? "Test Server",
		transport: opts.transport ?? "stdio",
		auth: opts.auth ?? "none",
		webhooks: extractWebhooks(spec),
		target: opts.target,
	});
	const file = (rel: string) => readFileSync(join(dir, rel), "utf-8");
	return {
		dir,
		file,
		toolsJson: () => JSON.parse(file("tools.json")),
		config: () => file("src/config.ts"),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}
