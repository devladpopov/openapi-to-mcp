import type {
	OpenApiSpec,
	Operation,
	Parameter,
	McpToolDefinition,
	MapperOptions,
	JsonSchema,
	SecurityScheme,
	PaginationConfig,
} from "../types.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function mapToMcpTools(spec: OpenApiSpec, options: MapperOptions = {}): McpToolDefinition[] {
	const tools: McpToolDefinition[] = [];
	const detectPagination = options.detectPagination ?? true;

	for (const [path, pathItem] of Object.entries(spec.paths)) {
		for (const method of HTTP_METHODS) {
			const operation = pathItem[method];
			if (!operation) continue;
			if (operation["x-mcp-exclude"]) continue;

			if (options.excludeTags?.length && operation.tags?.some((t) => options.excludeTags!.includes(t))) {
				continue;
			}
			if (options.includeTags?.length && !operation.tags?.some((t) => options.includeTags!.includes(t))) {
				continue;
			}

			const tool = mapOperation(spec, path, method, operation, pathItem.parameters, detectPagination);
			if (tool) {
				if (options.excludeOperations?.includes(tool.name)) continue;
				tools.push(tool);
			}
		}
	}

	return tools;
}

function mapOperation(
	spec: OpenApiSpec,
	path: string,
	method: string,
	op: Operation,
	pathParams?: Parameter[],
	detectPagination?: boolean,
): McpToolDefinition | null {
	const name = op["x-mcp-name"] ?? op.operationId ?? generateToolName(method, path);
	const description =
		op["x-mcp-description"] ?? op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`;

	const allParams = mergeParams(pathParams, op.parameters);
	const inputSchema = buildInputSchema(op, allParams);
	const auth = resolveAuth(spec, op);
	const pagination = detectPagination ? detectPaginationConfig(op, allParams) : null;
	const streaming = isStreamingResponse(op);

	// If pagination is detected, add cursor and limit to the input schema
	if (pagination) {
		inputSchema.properties = inputSchema.properties ?? {};
		inputSchema.properties.cursor = {
			type: "string",
			description: "Opaque pagination cursor. Omit for first page.",
		};
		inputSchema.properties.limit = {
			type: "integer",
			description: `Maximum items per page (default: ${pagination.defaultLimit})`,
		};
		// Remove original pagination params (offset/page/limit) since we abstract them
		if (pagination.offsetParam) delete inputSchema.properties[pagination.offsetParam];
		if (pagination.pageParam) delete inputSchema.properties[pagination.pageParam];
		if (pagination.limitParam && pagination.limitParam !== "limit") {
			delete inputSchema.properties[pagination.limitParam];
		}
		// Remove from required too
		if (inputSchema.required) {
			inputSchema.required = inputSchema.required.filter(
				(r) => r !== pagination.offsetParam && r !== pagination.pageParam,
			);
			if (inputSchema.required.length === 0) inputSchema.required = undefined;
		}
	}

	return {
		name: sanitizeName(name),
		description: pagination ? `${description} (paginated)` : description,
		inputSchema,
		meta: {
			method: method.toUpperCase(),
			path,
			tags: op.tags ?? [],
			auth,
			pagination,
			streaming,
		},
	};
}

function mergeParams(pathParams?: Parameter[], opParams?: Parameter[]): Parameter[] {
	const allParams = [...(pathParams ?? []), ...(opParams ?? [])];
	const seen = new Set<string>();
	const result: Parameter[] = [];
	// Reverse so operation-level wins over path-level
	for (const p of allParams.reverse()) {
		const key = `${p.in}:${p.name}`;
		if (!seen.has(key)) {
			seen.add(key);
			result.push(p);
		}
	}
	return result;
}

function buildInputSchema(op: Operation, params: Parameter[]): JsonSchema {
	const properties: Record<string, JsonSchema> = {};
	const required: string[] = [];

	for (const param of params) {
		if (param.in === "header") continue;
		properties[param.name] = {
			...param.schema,
			description: param.description ?? param.schema?.description,
		};
		if (param.required) {
			required.push(param.name);
		}
	}

	const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
	if (bodySchema) {
		if (bodySchema.type === "object" && bodySchema.properties) {
			for (const [key, val] of Object.entries(bodySchema.properties)) {
				properties[key] = val;
			}
			if (bodySchema.required) {
				required.push(...bodySchema.required);
			}
		} else {
			properties.body = {
				...bodySchema,
				description: op.requestBody?.description ?? bodySchema.description,
			};
			if (op.requestBody?.required) {
				required.push("body");
			}
		}
	}

	return {
		type: "object",
		properties,
		required: required.length > 0 ? required : undefined,
	};
}

function detectPaginationConfig(op: Operation, params: Parameter[]): PaginationConfig | null {
	// Check for explicit x-mcp-pagination hint
	const hint = op["x-mcp-pagination"];
	if (hint) {
		return {
			type: hint.type,
			limitParam: hint.limitParam ?? "limit",
			offsetParam: hint.offsetParam,
			pageParam: hint.pageParam,
			cursorParam: hint.cursorParam,
			cursorPath: hint.cursorPath ?? "next_cursor",
			totalPath: hint.totalPath ?? "total",
			itemsPath: hint.itemsPath ?? "items",
			defaultLimit: 20,
		};
	}

	// Auto-detect from parameter names (only for GET operations)
	const paramNames = params.map((p) => p.name.toLowerCase());

	const hasLimit = paramNames.some((n) => n === "limit" || n === "per_page" || n === "page_size" || n === "pagesize");
	if (!hasLimit) return null;

	const limitParam = params.find((p) => {
		const n = p.name.toLowerCase();
		return n === "limit" || n === "per_page" || n === "page_size" || n === "pagesize";
	})!;

	// Cursor-based pagination
	const cursorParam = params.find((p) => {
		const n = p.name.toLowerCase();
		return n === "cursor" || n === "after" || n === "next_token" || n === "page_token" || n === "starting_after";
	});
	if (cursorParam) {
		return {
			type: "cursor",
			limitParam: limitParam.name,
			cursorParam: cursorParam.name,
			cursorPath: "next_cursor",
			totalPath: "total",
			itemsPath: "items",
			defaultLimit: 20,
		};
	}

	// Offset-based pagination
	const offsetParam = params.find((p) => {
		const n = p.name.toLowerCase();
		return n === "offset" || n === "skip";
	});
	if (offsetParam) {
		return {
			type: "offset",
			limitParam: limitParam.name,
			offsetParam: offsetParam.name,
			cursorPath: "next_cursor",
			totalPath: "total",
			itemsPath: "items",
			defaultLimit: 20,
		};
	}

	// Page-based pagination
	const pageParam = params.find((p) => {
		const n = p.name.toLowerCase();
		return n === "page" || n === "page_number" || n === "pagenumber";
	});
	if (pageParam) {
		return {
			type: "page",
			limitParam: limitParam.name,
			pageParam: pageParam.name,
			cursorPath: "next_cursor",
			totalPath: "total",
			itemsPath: "items",
			defaultLimit: 20,
		};
	}

	return null;
}

function isStreamingResponse(op: Operation): boolean {
	if (!op.responses) return false;
	const successResponse = op.responses["200"] ?? op.responses["201"];
	if (!successResponse?.content) return false;
	return (
		"text/event-stream" in successResponse.content ||
		"application/x-ndjson" in successResponse.content ||
		"application/stream+json" in successResponse.content
	);
}

function resolveAuth(spec: OpenApiSpec, op: Operation): SecurityScheme | null {
	const securityReqs = op.security ?? spec.security ?? [];
	if (securityReqs.length === 0) return null;

	const schemeName = Object.keys(securityReqs[0])[0];
	if (!schemeName) return null;

	return spec.components?.securitySchemes?.[schemeName] ?? null;
}

function generateToolName(method: string, path: string): string {
	const segments = path
		.split("/")
		.filter(Boolean)
		.map((s) => {
			if (s.startsWith("{") && s.endsWith("}")) {
				return `by_${s.slice(1, -1)}`;
			}
			return s;
		});
	return `${method}_${segments.join("_")}`;
}

function sanitizeName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
}
