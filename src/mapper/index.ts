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
	const usedNames = new Set<string>();

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
				tool.name = uniqueName(tool.name, usedNames);
				usedNames.add(tool.name);
				tools.push(tool);
			}
		}
	}

	return tools;
}

/** MCP tool names must match ^[a-zA-Z0-9_-]{1,64}$ and be unique per server. */
function uniqueName(name: string, used: Set<string>): string {
	let base = name.slice(0, 60);
	if (!used.has(base)) return base;
	let i = 2;
	while (used.has(`${base}_${i}`)) i++;
	return `${base}_${i}`;
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
	const { schema: inputSchema, queryParams, bodyParams, bodyMode, bodyContentType } = buildInputSchema(op, allParams);
	const auth = resolveAuth(spec, op);
	const pagination = detectPagination ? detectPaginationConfig(op, allParams) : null;
	const streaming = isStreamingResponse(op);
	const responseHint = buildResponseHint(op);

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

	// queryParams must reflect the final schema (pagination may remove params)
	const finalQueryParams = queryParams.filter(
		(q) =>
			!pagination ||
			(q !== pagination.offsetParam && q !== pagination.pageParam && q !== pagination.limitParam && q !== pagination.cursorParam),
	);

	let fullDescription = pagination ? `${description} (paginated)` : description;
	if (responseHint) fullDescription += responseHint;

	return {
		name: sanitizeName(name),
		description: fullDescription,
		inputSchema,
		meta: {
			method: method.toUpperCase(),
			path,
			tags: op.tags ?? [],
			auth,
			pagination,
			streaming,
			queryParams: finalQueryParams,
			bodyParams,
			bodyMode,
			bodyContentType,
		},
	};
}

/** Compact summary of the success response shape so the LLM knows what to expect. */
function buildResponseHint(op: Operation): string | null {
	const resp = op.responses?.["200"] ?? op.responses?.["201"];
	const schema = resp?.content?.["application/json"]?.schema;
	if (!schema) return null;

	let fields: string[] = [];
	let prefix = "Returns";
	if (schema.type === "array") {
		prefix = "Returns array of";
		if (schema.items?.properties) fields = Object.keys(schema.items.properties);
	} else if (schema.properties) {
		fields = Object.keys(schema.properties);
	}
	if (fields.length === 0) return null;

	const shown = fields.slice(0, 12);
	const suffix = fields.length > shown.length ? ", ..." : "";
	return ` ${prefix}: { ${shown.join(", ")}${suffix} }`;
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

interface BuiltInput {
	schema: JsonSchema;
	queryParams: string[];
	bodyParams: Array<[string, string]>;
	bodyMode: "none" | "fields" | "whole";
	bodyContentType: "json" | "form";
}

interface PaginationResponsePaths {
	cursorPath: string;
	totalPath: string;
	itemsPath: string;
}

function buildInputSchema(op: Operation, params: Parameter[]): BuiltInput {
	const properties: Record<string, JsonSchema> = {};
	const required: string[] = [];
	const queryParams: string[] = [];
	const bodyParams: Array<[string, string]> = [];
	let bodyMode: "none" | "fields" | "whole" = "none";

	for (const param of params) {
		if (param.in === "header" || param.in === "cookie") continue;
		properties[param.name] = {
			...param.schema,
			description: param.description ?? param.schema?.description,
		};
		if (param.in === "query") queryParams.push(param.name);
		if (param.required) {
			required.push(param.name);
		}
	}

	// JSON preferred; fall back to form-encoded (Stripe-style APIs use it exclusively)
	const content = op.requestBody?.content;
	const bodySchema = content?.["application/json"]?.schema ?? content?.["application/x-www-form-urlencoded"]?.schema;
	const bodyContentType: "json" | "form" =
		!content?.["application/json"] && content?.["application/x-www-form-urlencoded"] ? "form" : "json";
	if (bodySchema) {
		if (bodySchema.type === "object" && bodySchema.properties) {
			bodyMode = "fields";
			for (const [key, val] of Object.entries(bodySchema.properties)) {
				// Avoid collision with path/query params of the same name
				let propKey = key;
				if (propKey in properties) propKey = `body_${key}`;
				properties[propKey] = val;
				bodyParams.push([propKey, key]);
				if (bodySchema.required?.includes(key)) {
					required.push(propKey);
				}
			}
		} else {
			bodyMode = "whole";
			let bodyKey = "body";
			if (bodyKey in properties) bodyKey = "request_body";
			properties[bodyKey] = {
				...bodySchema,
				description: op.requestBody?.description ?? bodySchema.description,
			};
			bodyParams.push([bodyKey, "*"]);
			if (op.requestBody?.required) {
				required.push(bodyKey);
			}
		}
	}

	return {
		schema: {
			type: "object",
			properties,
			required: required.length > 0 ? required : undefined,
		},
		queryParams,
		bodyParams,
		bodyMode,
		bodyContentType,
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

	const responsePaths = inferPaginationResponsePaths(op);

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
			cursorPath: responsePaths.cursorPath,
			totalPath: responsePaths.totalPath,
			itemsPath: responsePaths.itemsPath,
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
			cursorPath: responsePaths.cursorPath,
			totalPath: responsePaths.totalPath,
			itemsPath: responsePaths.itemsPath,
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
			cursorPath: responsePaths.cursorPath,
			totalPath: responsePaths.totalPath,
			itemsPath: responsePaths.itemsPath,
			defaultLimit: 20,
		};
	}

	return null;
}

function inferPaginationResponsePaths(op: Operation): PaginationResponsePaths {
	const defaults: PaginationResponsePaths = {
		cursorPath: "next_cursor",
		totalPath: "total",
		itemsPath: "items",
	};
	const response = op.responses?.["200"] ?? op.responses?.["201"];
	const schema = response?.content?.["application/json"]?.schema;
	const properties = schema?.properties;
	if (!properties) return defaults;

	const arrayEntry = Object.entries(properties).find(([, propertySchema]) => propertySchema.type === "array");
	const cursorEntry = Object.entries(properties).find(([name, propertySchema]) => {
		if (propertySchema.type !== "string") return false;
		const normalized = name.toLowerCase();
		return (
			normalized === "next_cursor" ||
			normalized === "nextcursor" ||
			normalized === "cursor" ||
			normalized === "next_token"
		);
	});
	const totalEntry = Object.entries(properties).find(([name, propertySchema]) => {
		if (propertySchema.type !== "integer" && propertySchema.type !== "number") return false;
		const normalized = name.toLowerCase();
		return (
			normalized === "total" ||
			normalized === "total_count" ||
			normalized === "totalcount" ||
			normalized === "count"
		);
	});

	return {
		cursorPath: cursorEntry?.[0] ?? defaults.cursorPath,
		totalPath: totalEntry?.[0] ?? defaults.totalPath,
		itemsPath: arrayEntry?.[0] ?? defaults.itemsPath,
	};
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
