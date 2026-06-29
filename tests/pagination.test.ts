import { describe, expect, test } from "bun:test";
import { parseSpec } from "../src/parser/index.js";
import { mapToMcpTools } from "../src/mapper/index.js";
import { resolve } from "node:path";

const fixture = resolve(import.meta.dir, "fixtures/paginated-api.yaml");
const xquikFixture = resolve(import.meta.dir, "fixtures/xquik-search.yaml");

describe("pagination detection", () => {
	test("detects offset-based pagination (limit + offset)", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const listItems = tools.find((t) => t.name === "listItems")!;

		expect(listItems.meta.pagination).not.toBeNull();
		expect(listItems.meta.pagination!.type).toBe("offset");
		expect(listItems.meta.pagination!.limitParam).toBe("limit");
		expect(listItems.meta.pagination!.offsetParam).toBe("offset");
		expect(listItems.meta.pagination!.itemsPath).toBe("items");
		expect(listItems.meta.pagination!.totalPath).toBe("total");
	});

	test("detects page-based pagination (per_page + page)", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const listUsers = tools.find((t) => t.name === "listUsers")!;

		expect(listUsers.meta.pagination).not.toBeNull();
		expect(listUsers.meta.pagination!.type).toBe("page");
		expect(listUsers.meta.pagination!.limitParam).toBe("per_page");
		expect(listUsers.meta.pagination!.pageParam).toBe("page");
		expect(listUsers.meta.pagination!.itemsPath).toBe("data");
		expect(listUsers.meta.pagination!.totalPath).toBe("total_count");
	});

	test("detects cursor-based pagination (limit + after)", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const listEvents = tools.find((t) => t.name === "listEvents")!;

		expect(listEvents.meta.pagination).not.toBeNull();
		expect(listEvents.meta.pagination!.type).toBe("cursor");
		expect(listEvents.meta.pagination!.cursorParam).toBe("after");
	});

	test("uses x-mcp-pagination hint when provided", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const listMessages = tools.find((t) => t.name === "listMessages")!;

		expect(listMessages.meta.pagination).not.toBeNull();
		expect(listMessages.meta.pagination!.type).toBe("offset");
		expect(listMessages.meta.pagination!.limitParam).toBe("count");
		expect(listMessages.meta.pagination!.offsetParam).toBe("skip");
		expect(listMessages.meta.pagination!.itemsPath).toBe("data");
		expect(listMessages.meta.pagination!.totalPath).toBe("total_count");
	});

	test("no pagination for simple endpoints", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const getSimple = tools.find((t) => t.name === "getSimple")!;

		expect(getSimple.meta.pagination).toBeNull();
	});

	test("paginated tools get cursor and limit params in schema", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const listItems = tools.find((t) => t.name === "listItems")!;

		expect(listItems.inputSchema.properties!.cursor).toBeDefined();
		expect(listItems.inputSchema.properties!.cursor.type).toBe("string");
		expect(listItems.inputSchema.properties!.limit).toBeDefined();
		expect(listItems.inputSchema.properties!.limit.type).toBe("integer");
	});

	test("original offset/page params removed from paginated tools", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const listItems = tools.find((t) => t.name === "listItems")!;

		// offset should be removed (abstracted by cursor)
		expect(listItems.inputSchema.properties!.offset).toBeUndefined();
		// but category (a real filter) should remain
		expect(listItems.inputSchema.properties!.category).toBeDefined();
	});

	test("paginated tool description includes (paginated)", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec);
		const listItems = tools.find((t) => t.name === "listItems")!;

		expect(listItems.description).toContain("(paginated)");
	});

	test("pagination disabled when detectPagination is false", async () => {
		const spec = await parseSpec(fixture);
		const tools = mapToMcpTools(spec, { detectPagination: false });
		const listItems = tools.find((t) => t.name === "listItems")!;

		expect(listItems.meta.pagination).toBeNull();
		expect(listItems.inputSchema.properties!.offset).toBeDefined();
	});

	test("infers item and cursor paths from paginated response schemas", async () => {
		const spec = await parseSpec(xquikFixture);
		const tools = mapToMcpTools(spec);
		const searchTweets = tools.find((t) => t.name === "searchTweets")!;

		expect(searchTweets.meta.pagination).not.toBeNull();
		expect(searchTweets.meta.pagination!.type).toBe("cursor");
		expect(searchTweets.meta.pagination!.cursorParam).toBe("cursor");
		expect(searchTweets.meta.pagination!.cursorPath).toBe("next_cursor");
		expect(searchTweets.meta.pagination!.itemsPath).toBe("tweets");
	});

	test("keeps real query filters while abstracting pagination inputs", async () => {
		const spec = await parseSpec(xquikFixture);
		const tools = mapToMcpTools(spec);
		const searchTweets = tools.find((t) => t.name === "searchTweets")!;

		expect([...searchTweets.meta.queryParams].sort()).toEqual(
			["q", "queryType", "sinceTime", "untilTime"].sort(),
		);
		expect(searchTweets.inputSchema.required).toEqual(["q"]);
		expect(searchTweets.inputSchema.properties!.queryType.enum).toEqual(["Latest", "Top"]);
		expect(searchTweets.inputSchema.properties!.limit.type).toBe("integer");
		expect(searchTweets.inputSchema.properties!.cursor.description).toBe(
			"Opaque pagination cursor. Omit for first page.",
		);
	});
});
