import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { parseSpec } from "../src/parser/index.js";
import { mapToMcpTools } from "../src/mapper/index.js";
import { generate } from "../src/generator/index.js";
import { resolve, join } from "node:path";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

// Full e2e: generate a server from the most complex fixture, install its real
// dependencies (zod 3, MCP SDK) into a tmp dir, and typecheck the output with tsc.
// This catches template bugs that unit tests on generated source strings miss.

const fixture = resolve(import.meta.dir, "fixtures/complex-api.yaml");
let outputDir: string;

beforeAll(async () => {
	outputDir = mkdtempSync(join(tmpdir(), "openapi-to-mcp-e2e-"));
	const spec = await parseSpec(fixture);
	const tools = mapToMcpTools(spec);
	await generate({
		tools,
		spec,
		outputDir,
		serverName: "ComplexE2E",
		transport: "stdio",
		auth: "api-key",
	});
});

afterAll(() => {
	if (!outputDir || !existsSync(outputDir)) return;
	// node_modules removal can exceed bun's 5s hook timeout on Windows,
	// so detach the cleanup instead of blocking the test run.
	if (process.platform === "win32") {
		spawn("cmd", ["/c", "rmdir", "/s", "/q", outputDir], {
			detached: true,
			stdio: "ignore",
		}).unref();
	} else {
		rmSync(outputDir, { recursive: true, force: true });
	}
});

describe("e2e: generated server compiles with real dependencies", () => {
	test(
		"bun install succeeds in generated project",
		() => {
			const result = spawnSync("bun", ["install", "--no-progress"], {
				cwd: outputDir,
				encoding: "utf-8",
				timeout: 120_000,
				shell: process.platform === "win32",
			});
			if (result.status !== 0) {
				console.error(result.stdout, result.stderr);
			}
			expect(result.status).toBe(0);
			expect(existsSync(join(outputDir, "node_modules"))).toBe(true);
		},
		130_000,
	);

	test(
		"tsc --noEmit passes on generated code",
		() => {
			// Use the tsc JS entry directly: bun on Windows does not create .cmd shims
			const tscJs = join(outputDir, "node_modules", "typescript", "lib", "tsc.js");
			const result = spawnSync("bun", [tscJs, "--noEmit"], {
				cwd: outputDir,
				encoding: "utf-8",
				timeout: 120_000,
				shell: process.platform === "win32",
			});
			if (result.status !== 0) {
				console.error(result.stdout, result.stderr);
			}
			expect(result.status).toBe(0);
		},
		130_000,
	);
});
