import type {
	OpenApiSpec,
	Operation,
	PathItem,
	Parameter,
	McpToolDefinition,
	MapperOptions,
	JsonSchema,
	SecurityScheme,
} from "../types.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function mapToMcpTools(spec: OpenApiSpec, options: MapperOptions = {}): McpToolDefinition[] {
	const tools: McpToolDefinition[] = [];

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

			const tool = mapOperation(spec, path, method, operation, pathItem.parameters);
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
): McpToolDefinition | null {
	const name = op["x-mcp-name"] ?? op.operationId ?? generateToolName(method, path);
	const description =
		op["x-mcp-description"] ?? op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`;

	const inputSchema = buildInputSchema(op, pathParams);
	const auth = resolveAuth(spec, op);

	return {
		name: sanitizeName(name),
		description,
		inputSchema,
		meta: {
			method: method.toUpperCase(),
			path,
			tags: op.tags ?? [],
			auth,
		},
	};
}

function buildInputSchema(op: Operation, pathParams?: Parameter[]): JsonSchema {
	const properties: Record<string, JsonSchema> = {};
	const required: string[] = [];

	// Merge path-level and operation-level parameters
	const allParams = [...(pathParams ?? []), ...(op.parameters ?? [])];
	// Dedupe by name+in, operation-level wins
	const seen = new Set<string>();
	const params: Parameter[] = [];
	for (const p of allParams.reverse()) {
		const key = `${p.in}:${p.name}`;
		if (!seen.has(key)) {
			seen.add(key);
			params.push(p);
		}
	}

	for (const param of params) {
		if (param.in === "header") continue; // headers handled by auth layer
		properties[param.name] = {
			...param.schema,
			description: param.description ?? param.schema?.description,
		};
		if (param.required) {
			required.push(param.name);
		}
	}

	// Request body (JSON only for now)
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

function resolveAuth(spec: OpenApiSpec, op: Operation): SecurityScheme | null {
	const securityReqs = op.security ?? [];
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
