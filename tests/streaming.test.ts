import { describe, expect, test } from "bun:test";
import { parseSpec } from "../src/parser/index.js";
import { mapToMcpTools } from "../src/mapper/index.js";
import { resolve } from "node:path";

const fixture = resolve(import.meta.dir, "fixtures/streaming-api.yaml");

describe("streaming detection", () => {
	test("detects SSE streaming response", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const streamEvents = tools.find((t) => t.name === "streamEvents")!;

		expect(streamEvents.meta.streaming).toBe(true);
	});

	test("detects NDJSON streaming response", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const streamLogs = tools.find((t) => t.name === "streamLogs")!;

		expect(streamLogs.meta.streaming).toBe(true);
	});

	test("regular JSON endpoint is not streaming", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const getData = tools.find((t) => t.name === "getData")!;

		expect(getData.meta.streaming).toBe(false);
	});
});
