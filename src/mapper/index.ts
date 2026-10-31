import { PROFILES, adaptInputSchema, cleanText, truncate, type SchemaProfile } from "../schema/adapt.js";
import { mergeAllOf } from "../schema/merge.js";
import type {
	AuthMode,
	OpenApiSpec,
	Operation,
	Parameter,
	McpToolDefinition,
	MapperOptions,
	JsonSchema,
	SecurityScheme,
	PaginationConfig,
	ParamPair,
	PathItem,
	QueryStyle,
	WebhookDefinition,
	ToolAnnotations,
} from "../types.js";

const TOOL_METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Headers the generated runtime sets itself; spec-declared copies are ignored. */
const MANAGED_HEADERS = new Set(["authorization", "content-type", "accept", "content-length", "user-agent", "cookie"]);
/** Parameters that carry credentials (Slack's `token` header, `?api_key=`). */
const CREDENTIAL_PARAMS = /^(token|access_token|auth_token|api_key|apikey|api-key|x-api-key|x-auth-token|client_secret)$/;

export function mapToMcpTools(spec: OpenApiSpec, options: MapperOptions = {}): McpToolDefinition[] {
	const tools: McpToolDefinition[] = [];
	const detectPagination = options.detectPagination ?? true;
	const profile = PROFILES[options.target ?? "generic"];
	const usedNames = new Set<string>();
	const maxNameLength = toolNameBudget(profile, options.serverName ?? spec.info?.title ?? "");
	const authHeaderNames = apiKeyHeaderNames(spec);

	for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
		if (!pathItem || typeof pathItem !== "object") continue;
		for (const method of TOOL_METHODS) {
			const operation = pathItem[method];
			if (!operation || typeof operation !== "object") continue;
			if (operation["x-mcp-exclude"]) continue;
			if (options.excludeDeprecated && operation.deprecated) continue;

			if (options.excludeTags?.length && operation.tags?.some((t) => options.excludeTags!.includes(t))) {
				continue;
			}
			if (options.includeTags?.length && !operation.tags?.some((t) => options.includeTags!.includes(t))) {
				continue;
			}

			const tool = mapOperation(spec, path, method, operation, pathItem, {
				detectPagination,
				profile,
				authHeaderNames,
				hasSecurity: Object.keys(spec.components?.securitySchemes ?? {}).length > 0,
			});
			if (options.excludeOperations?.includes(tool.name)) continue;
			tool.name = uniqueName(tool.name, usedNames, maxNameLength, profile.nameMustStartWithLetter);
			usedNames.add(tool.name);
			tools.push(tool);
		}
	}

	return tools;
}

/** Collect incoming events: 3.1 top-level `webhooks` and per-operation `callbacks`. */
export function extractWebhooks(spec: OpenApiSpec): WebhookDefinition[] {
	const out: WebhookDefinition[] = [];
	const used = new Set<string>();
	const add = (name: string, item: PathItem | undefined, source: "webhook" | "callback", operation?: string) => {
		if (!item || typeof item !== "object") return;
		const op = item.post ?? item.put ?? item.get ?? Object.values(item).find((v) => v && typeof v === "object" && "responses" in (v as object));
		const opObj = (op ?? {}) as Operation;
		let slug = slugify(name) || "event";
		let i = 2;
		const base = slug;
		while (used.has(slug)) slug = `${base}-${i++}`;
		used.add(slug);
		const schema = mergeAllOf(firstBodySchema(opObj.requestBody?.content) ?? {});
		const description = cleanText(
			opObj.summary ?? opObj.description ?? item.summary ?? item.description ?? `${name} event`,
		);
		out.push({
			name,
			slug,
			description: truncate(description, 300),
			source,
			operation,
			payloadFields: Object.keys(schema.properties ?? {}).slice(0, 20),
		});
	};

	for (const [name, item] of Object.entries(spec.webhooks ?? {})) add(name, item, "webhook");
	for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
		for (const method of TOOL_METHODS) {
			const op = pathItem?.[method];
			if (!op?.callbacks) continue;
			for (const [cbName, cb] of Object.entries(op.callbacks)) {
				if (!cb || typeof cb !== "object") continue;
				for (const item of Object.values(cb)) {
					add(cbName, item as PathItem, "callback", op.operationId ?? `${method.toUpperCase()} ${path}`);
				}
			}
		}
	}
	return out;
}

interface MapContext {
	detectPagination: boolean;
	profile: SchemaProfile;
	/** apiKey scheme parameter names (header or query), lowercased. */
	authHeaderNames: Set<string>;
	hasSecurity: boolean;
}

/** MCP tool names must match ^[a-zA-Z0-9_-]{1,64}$ and be unique per server. */
function uniqueName(name: string, used: Set<string>, max: number, mustStartWithLetter: boolean): string {
	let base = name || "tool";
	if (mustStartWithLetter && !/^[a-zA-Z_]/.test(base)) base = `op_${base}`;
	base = base.slice(0, max).replace(/_+$/, "") || "tool";
	if (!used.has(base)) return base;
	let i = 2;
	const make = (n: number) => `${base.slice(0, max - String(n).length - 1)}_${n}`;
	while (used.has(make(i))) i++;
	return make(i);
}

function toolNameBudget(profile: SchemaProfile, serverName: string): number {
	if (profile.combinedNameBudget === null) return 64;
	// Clients prefix tools as "<server>_<tool>" or "mcp__<server>__<tool>".
	const prefix = slugify(serverName).length + 1;
	return Math.max(24, Math.min(64, profile.combinedNameBudget - prefix));
}

function mapOperation(
	spec: OpenApiSpec,
	path: string,
	method: string,
	op: Operation,
	pathItem: PathItem,
	ctx: MapContext,
): McpToolDefinition {
	const name = sanitizeName(op["x-mcp-name"] ?? op.operationId ?? generateToolName(method, path));
	const allParams = mergeParams(pathItem.parameters, op.parameters);
	const built = buildInputSchema(op, allParams, method, path, ctx);
	const auth = resolveAuth(spec, op);
	const pagination =
		ctx.detectPagination && method === "get" ? detectPaginationConfig(op, allParams) : null;
	const streaming = isStreamingResponse(op);

	const inputSchema = built.schema;
	let { queryParams } = built;
	const server = op.servers?.[0]?.url ?? pathItem.servers?.[0]?.url;
	const globalServer = spec.servers?.find((s) => /^https?:\/\//.test(s.url))?.url;
	const baseUrl = server && /^https?:\/\//.test(server) && !server.includes("{") && server !== globalServer ? server : undefined;

	if (pagination) {
		const props = inputSchema.properties!;
		const wireToProp = new Map(queryParams.map(([prop, wire]) => [wire, prop]));
		const paginationWire = [pagination.offsetParam, pagination.pageParam, pagination.limitParam, pagination.cursorParam].filter(
			Boolean,
		) as string[];
		const removedProps = new Set(paginationWire.map((w) => wireToProp.get(w)).filter(Boolean) as string[]);
		for (const prop of removedProps) delete props[prop];
		props.cursor = { type: "string", description: "Opaque pagination cursor from a previous call's next_cursor. Omit for the first page." };
		props.limit = { type: "integer", description: `Maximum items per page (default: ${pagination.defaultLimit})` };
		queryParams = queryParams.filter(([prop]) => !removedProps.has(prop));
		if (inputSchema.required) {
			inputSchema.required = inputSchema.required.filter((r) => !removedProps.has(r) && r !== "cursor" && r !== "limit");
		}
	}
	if (inputSchema.required?.length === 0) inputSchema.required = undefined;

	const adapted = adaptInputSchema(inputSchema, ctx.profile);

	return {
		name,
		title: op.summary ? truncate(cleanText(op.summary), 100) : undefined,
		description: buildDescription(op, method, path, pagination !== null, ctx.profile),
		inputSchema: adapted.schema,
		annotations: buildAnnotations(method, op),
		meta: {
			method: method.toUpperCase(),
			path,
			tags: op.tags ?? [],
			auth,
			requiresAuth: !(Array.isArray(op.security) && op.security.length === 0),
			pagination,
			streaming,
			pathParams: built.pathParams,
			queryParams,
			headerParams: built.headerParams,
			bodyParams: built.bodyParams,
			bodyMode: built.bodyMode,
			bodyContentType: built.bodyContentType,
			bodyMediaType: built.bodyMediaType,
			jsonArgs: adapted.jsonPaths.length > 0 ? adapted.jsonPaths : undefined,
			looseArgs: adapted.loosePaths.length > 0 ? adapted.loosePaths : undefined,
			jsonAnyArgs: adapted.anyPaths.length > 0 ? adapted.anyPaths : undefined,
			queryStyles: Object.keys(built.queryStyles).length > 0 ? built.queryStyles : undefined,
			baseUrl,
		},
	};
}

function buildDescription(op: Operation, method: string, path: string, paginated: boolean, profile: SchemaProfile): string {
	const custom = op["x-mcp-description"];
	let text: string;
	if (custom) {
		text = cleanText(custom);
	} else {
		const summary = op.summary ? cleanText(op.summary) : "";
		const details = op.description ? cleanText(op.description) : "";
		if (summary && details && !details.startsWith(summary)) {
			text = `${summary}. ${truncate(details, 400)}`;
		} else {
			text = truncate(summary || details, 600) || `${method.toUpperCase()} ${path}`;
		}
	}
	if (op.deprecated) text = `[Deprecated] ${text}`;
	if (paginated) text += " (paginated: pass next_cursor back as cursor to get more)";
	const hint = buildResponseHint(op);
	if (hint) text += hint;
	return truncate(text, profile.maxToolDescription);
}

function buildAnnotations(method: string, op: Operation): ToolAnnotations {
	const a: ToolAnnotations = {};
	if (op.summary) a.title = truncate(cleanText(op.summary), 100);
	if (method === "get") {
		a.readOnlyHint = true;
	} else {
		a.readOnlyHint = false;
		a.destructiveHint = method === "delete";
		a.idempotentHint = method === "put" || method === "delete";
	}
	a.openWorldHint = true;
	return a;
}

/** Compact summary of the success response shape so the LLM knows what to expect. */
function buildResponseHint(op: Operation): string | null {
	const resp = op.responses?.["200"] ?? op.responses?.["201"] ?? op.responses?.["2XX"];
	const raw = firstJsonSchema(resp?.content);
	if (!raw) return null;
	const schema = mergeAllOf(raw);

	let fields: string[] = [];
	let prefix = "Returns";
	if (schema.type === "array" || (!schema.properties && schema.items)) {
		prefix = "Returns array of";
		const items = schema.items ? mergeAllOf(schema.items) : undefined;
		if (items?.properties) fields = Object.keys(items.properties);
	} else if (schema.properties) {
		fields = Object.keys(schema.properties);
	}
	if (fields.length === 0) return null;

	const shown = fields.slice(0, 12);
	const suffix = fields.length > shown.length ? ", ..." : "";
	return ` ${prefix}: { ${shown.join(", ")}${suffix} }`;
}

function mergeParams(pathParams?: Parameter[], opParams?: Parameter[]): Parameter[] {
	const allParams = [...(pathParams ?? []), ...(opParams ?? [])].filter(
		(p) => p && typeof p === "object" && typeof p.name === "string" && p.in,
	);
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
	return result.reverse();
}

interface BuiltInput {
	schema: JsonSchema;
	pathParams: ParamPair[];
	queryParams: ParamPair[];
	headerParams: ParamPair[];
	bodyParams: ParamPair[];
	bodyMode: "none" | "fields" | "whole";
	bodyContentType: McpToolDefinition["meta"]["bodyContentType"];
	bodyMediaType?: string;
	queryStyles: Record<string, QueryStyle>;
}

function buildInputSchema(op: Operation, params: Parameter[], method: string, path: string, ctx: MapContext): BuiltInput {
	const properties: Record<string, JsonSchema> = {};
	const required: string[] = [];
	const pathParams: ParamPair[] = [];
	const queryParams: ParamPair[] = [];
	const headerParams: ParamPair[] = [];
	const bodyParams: ParamPair[] = [];
	const queryStyles: Record<string, QueryStyle> = {};
	let bodyMode: BuiltInput["bodyMode"] = "none";
	const used = new Set<string>();

	const templateNames = new Set([...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]));

	for (const param of params) {
		if (param.in === "cookie") continue;
		const lower = param.name.toLowerCase();
		if (param.in === "header" && (MANAGED_HEADERS.has(lower) || CREDENTIAL_PARAMS.test(lower))) continue;
		// Credentials come from the server environment, never from the model.
		if ((param.in === "header" || param.in === "query") && ctx.authHeaderNames.has(lower)) continue;
		if (param.in === "query" && ctx.hasSecurity && CREDENTIAL_PARAMS.test(lower)) continue;
		if (param.in === "path" && !templateNames.has(param.name)) continue;
		if (param.deprecated && !param.required && param.in !== "path") continue;

		const key = propertyKey(param.name, used, param.in === "header" ? "header_" : "");
		used.add(key);
		let schema = param.schema ?? firstJsonSchema(param.content) ?? { type: "string" };
		// A path segment can never be null, whatever the spec says.
		if (param.in === "path") schema = nonNullable(schema);
		properties[key] = {
			...schema,
			description: param.description ?? schema.description,
		};
		const pair: ParamPair = [key, param.name];
		if (param.in === "path") pathParams.push(pair);
		else if (param.in === "query") {
			queryParams.push(pair);
			const style = queryStyle(param, mergeAllOf(schema));
			if (style) queryStyles[param.name] = style;
		}
		else headerParams.push(pair);
		if (param.required || param.in === "path") required.push(key);
	}

	// Path template variables with no declared parameter still need a value.
	for (const name of templateNames) {
		if (pathParams.some(([, wire]) => wire === name)) continue;
		const key = propertyKey(name, used, "");
		used.add(key);
		properties[key] = { type: "string" };
		pathParams.push([key, name]);
		required.push(key);
	}

	// fetch cannot send a body with GET; Stripe declares empty form bodies on every GET.
	const body = method === "get" || isEmptyBody(op.requestBody?.content) ? null : pickBodyContent(op.requestBody?.content);
	let bodyContentType: BuiltInput["bodyContentType"] = "json";
	let bodyMediaType: string | undefined;
	if (body) {
		bodyContentType = body.kind;
		bodyMediaType = body.mediaType;
		const bodySchema = mergeAllOf(body.schema ?? {});
		const fieldEntries = Object.entries(bodySchema.properties ?? {}).filter(
			([, v]) => !(v && typeof v === "object" && v.readOnly),
		);
		const isObject =
			(bodySchema.type === "object" || bodySchema.type === undefined) &&
			fieldEntries.length > 0 &&
			!bodySchema.oneOf &&
			!bodySchema.anyOf;
		if (isObject && (body.kind === "json" || body.kind === "form" || body.kind === "multipart")) {
			bodyMode = "fields";
			for (const [field, val] of fieldEntries) {
				const key = propertyKey(field, used, "body_");
				used.add(key);
				properties[key] = body.kind === "multipart" ? multipartField(val) : val;
				bodyParams.push([key, field]);
				if (bodySchema.required?.includes(field)) required.push(key);
			}
		} else {
			bodyMode = "whole";
			const key = propertyKey("body", used, "request_");
			used.add(key);
			let schema: JsonSchema = body.schema ?? {};
			if (body.kind === "binary") {
				schema = { type: "string", description: "Request body content. Prefix with 'base64:' to send binary data." };
			} else if (body.kind === "text") {
				schema = { type: "string" };
			}
			properties[key] = {
				...schema,
				description: op.requestBody?.description ?? schema.description,
			};
			bodyParams.push([key, "*"]);
			if (op.requestBody?.required) required.push(key);
		}
	}

	return {
		schema: {
			type: "object",
			properties,
			required: required.length > 0 ? required : undefined,
		},
		pathParams,
		queryParams,
		headerParams,
		bodyParams,
		bodyMode,
		bodyContentType,
		bodyMediaType,
		queryStyles,
	};
}

function queryStyle(param: Parameter, schema: JsonSchema): QueryStyle | null {
	const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
	const isObject = type === "object" || (!type && !!schema.properties);
	const isArray = type === "array" || (!type && !!schema.items);
	if (param.style === "deepObject") return "deep";
	if (param.style === "spaceDelimited") return "ssv";
	if (param.style === "pipeDelimited") return "pipe";
	const explode = param.explode ?? true;
	if (isArray && !explode) return "csv";
	if (isObject) return explode ? "flat" : "csv";
	return null;
}

function nonNullable(schema: JsonSchema): JsonSchema {
	const { nullable: _n, ...rest } = mergeAllOf(schema);
	if (Array.isArray(rest.type)) {
		const types = rest.type.filter((t) => t !== "null");
		rest.type = types.length === 1 ? types[0] : types;
	}
	const variants = rest.anyOf ?? rest.oneOf;
	if (variants) {
		const kept = variants.filter((v) => v?.type !== "null");
		if (rest.anyOf) rest.anyOf = kept;
		else rest.oneOf = kept;
	}
	return rest;
}

/** A body that can carry nothing: an object with no properties that forbids extra keys. */
function isEmptyBody(content?: Record<string, { schema?: JsonSchema }>): boolean {
	if (!content) return false;
	return Object.values(content).every((m) => {
		const s = m?.schema ? mergeAllOf(m.schema) : undefined;
		return !!s && Object.keys(s.properties ?? {}).length === 0 && s.additionalProperties === false && !s.anyOf && !s.oneOf;
	});
}

function multipartField(schema: JsonSchema): JsonSchema {
	if (schema?.type === "string" && (schema.format === "binary" || schema.format === "byte")) {
		return {
			type: "string",
			description: `${schema.description ? `${schema.description} ` : ""}(file content; prefix with 'base64:' for binary data)`,
		};
	}
	return schema;
}

interface BodyContent {
	kind: "json" | "form" | "multipart" | "text" | "binary";
	mediaType: string;
	schema?: JsonSchema;
}

/** Choose the request body representation the runtime can send, JSON first. */
function pickBodyContent(content?: Record<string, { schema?: JsonSchema }>): BodyContent | null {
	if (!content || typeof content !== "object") return null;
	const types = Object.keys(content);
	if (types.length === 0) return null;
	const find = (pred: (t: string) => boolean) => types.find((t) => pred(t.toLowerCase().split(";")[0].trim()));
	const json = find((t) => t === "application/json") ?? find((t) => t.endsWith("+json") || t.endsWith("/json")) ?? find((t) => t === "*/*");
	if (json) return { kind: "json", mediaType: json === "*/*" ? "application/json" : json.split(";")[0], schema: content[json].schema };
	const form = find((t) => t === "application/x-www-form-urlencoded");
	if (form) return { kind: "form", mediaType: form, schema: content[form].schema };
	const multipart = find((t) => t.startsWith("multipart/"));
	if (multipart) return { kind: "multipart", mediaType: "multipart/form-data", schema: content[multipart].schema };
	const text = find((t) => t.startsWith("text/") || t.endsWith("+xml") || t.endsWith("/xml"));
	if (text) return { kind: "text", mediaType: text.split(";")[0], schema: content[text].schema };
	return { kind: "binary", mediaType: types[0].split(";")[0], schema: content[types[0]].schema };
}

function firstJsonSchema(content?: Record<string, { schema?: JsonSchema }>): JsonSchema | undefined {
	if (!content || typeof content !== "object") return undefined;
	const key =
		Object.keys(content).find((t) => t.startsWith("application/json")) ??
		Object.keys(content).find((t) => t.includes("json")) ??
		Object.keys(content)[0];
	return key ? content[key]?.schema : undefined;
}

function firstBodySchema(content?: Record<string, { schema?: JsonSchema }>): JsonSchema | undefined {
	return firstJsonSchema(content);
}

/**
 * Input property keys must match ^[a-zA-Z0-9_.-]{1,64}$ (Anthropic rejects
 * anything else), so `filter[status]`, `$top` or `expand[]` are renamed; the
 * original name is kept as the wire name.
 */
function propertyKey(name: string, used: Set<string>, collisionPrefix: string): string {
	let key = name
		.replace(/\[\]$/, "")
		.replace(/[^a-zA-Z0-9_.-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!key) key = "param";
	key = key.slice(0, 64);
	if (!used.has(key)) return key;
	if (collisionPrefix) {
		const prefixed = `${collisionPrefix}${key}`.slice(0, 64);
		if (!used.has(prefixed)) return prefixed;
	}
	let i = 2;
	while (used.has(`${key.slice(0, 60)}_${i}`)) i++;
	return `${key.slice(0, 60)}_${i}`;
}

const LIMIT_NAMES = new Set(["limit", "per_page", "perpage", "page_size", "pagesize", "count", "max_results", "maxresults", "top", "$top", "size"]);
const CURSOR_NAMES = new Set([
	"cursor",
	"after",
	"next_token",
	"nexttoken",
	"page_token",
	"pagetoken",
	"starting_after",
	"start_cursor",
	"continuation_token",
	"continuationtoken",
	"next_cursor",
]);
const OFFSET_NAMES = new Set(["offset", "skip", "$skip", "start"]);
const PAGE_NAMES = new Set(["page", "page_number", "pagenumber", "page_num"]);

function detectPaginationConfig(op: Operation, params: Parameter[]): PaginationConfig | null {
	const hint = op["x-mcp-pagination"];
	if (hint) {
		return {
			type: hint.type,
			limitParam: hint.limitParam ?? "limit",
			offsetParam: hint.offsetParam,
			pageParam: hint.pageParam,
			cursorParam: hint.cursorParam,
			cursorPath: hint.cursorPath ?? "",
			totalPath: hint.totalPath ?? "",
			itemsPath: hint.itemsPath ?? "",
			defaultLimit: 20,
		};
	}

	const query = params.filter((p) => p.in === "query");
	const find = (names: Set<string>) => query.find((p) => names.has(p.name.toLowerCase()));
	const limitParam = find(LIMIT_NAMES);
	if (!limitParam) return null;
	// "count"/"size"/"top" are only treated as page sizes next to a cursor/offset/page param.
	const defaultLimit = clampLimit(limitParam.schema);

	const base = { limitParam: limitParam.name, cursorPath: "", totalPath: "", itemsPath: "", defaultLimit };
	const cursorParam = find(CURSOR_NAMES);
	if (cursorParam) return { type: "cursor", cursorParam: cursorParam.name, ...base };
	const offsetParam = find(OFFSET_NAMES);
	if (offsetParam) return { type: "offset", offsetParam: offsetParam.name, ...base };
	const pageParam = find(PAGE_NAMES);
	if (pageParam) return { type: "page", pageParam: pageParam.name, ...base };
	return null;
}

function clampLimit(schema?: JsonSchema): number {
	const def = typeof schema?.default === "number" ? schema.default : 20;
	const max = typeof schema?.maximum === "number" ? schema.maximum : 100;
	return Math.max(1, Math.min(def, max, 100));
}

function isStreamingResponse(op: Operation): boolean {
	if (!op.responses) return false;
	const successResponse = op.responses["200"] ?? op.responses["201"];
	if (!successResponse?.content) return false;
	const types = Object.keys(successResponse.content);
	// Endpoints that can also answer with plain JSON are treated as regular calls.
	if (types.some((t) => t === "application/json")) return false;
	return types.some((t) => t === "text/event-stream" || t === "application/x-ndjson" || t === "application/stream+json");
}

function resolveAuth(spec: OpenApiSpec, op: Operation): SecurityScheme | null {
	const securityReqs = op.security ?? spec.security ?? [];
	for (const req of securityReqs) {
		const schemeName = Object.keys(req ?? {})[0];
		if (!schemeName) continue;
		const scheme = spec.components?.securitySchemes?.[schemeName];
		if (scheme) return scheme;
	}
	return null;
}

function apiKeyHeaderNames(spec: OpenApiSpec): Set<string> {
	const names = new Set<string>();
	for (const s of Object.values(spec.components?.securitySchemes ?? {})) {
		if (s?.type === "apiKey" && s.in !== "cookie" && s.name) names.add(s.name.toLowerCase());
	}
	return names;
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
	return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

/**
 * Pick the auth mode the generated server should use. Security requirement
 * alternatives are ranked (global first, then per-operation): single-scheme
 * alternatives beat combined ones, and simpler credentials win (bearer token >
 * API key > basic > OAuth2 flows), e.g. Stripe -> bearer, Cloudflare -> api_token.
 */
export function detectAuth(spec: OpenApiSpec): AuthMode {
	const schemes = spec.components?.securitySchemes ?? {};
	const alternatives: string[][] = [];
	for (const req of spec.security ?? []) alternatives.push(Object.keys(req ?? {}));
	for (const item of Object.values(spec.paths ?? {})) {
		for (const op of Object.values(item ?? {})) {
			const sec = (op as { security?: Array<Record<string, string[]>> })?.security;
			if (Array.isArray(sec)) for (const req of sec) alternatives.push(Object.keys(req ?? {}));
		}
	}
	if (alternatives.every((a) => a.length === 0)) for (const name of Object.keys(schemes)) alternatives.push([name]);

	let best: { mode: AuthMode; score: number } = { mode: "none", score: 0 };
	alternatives.forEach((alt, index) => {
		if (alt.length === 0) return;
		const s = schemes[alt[0]];
		if (!s) return;
		const mode = schemeMode(s);
		if (mode === "none") return;
		const rank = { bearer: 60, "api-key": 50, basic: 40, oauth2: 30, "oauth2-auth-code": 30, none: 0 }[mode];
		// Earlier alternatives are the spec's preference; combined schemes cannot be satisfied fully.
		const score = rank - (alt.length > 1 ? 25 : 0) - Math.min(index, 9);
		if (score > best.score) best = { mode, score };
	});
	return best.mode;
}

function schemeMode(s: SecurityScheme): AuthMode {
	if (s.type === "apiKey") return "api-key";
	if (s.type === "http" && s.scheme?.toLowerCase() === "bearer") return "bearer";
	if (s.type === "http" && s.scheme?.toLowerCase() === "basic") return "basic";
	if (s.type === "oauth2") {
		if (s.flows?.authorizationCode) return "oauth2-auth-code";
		if (s.flows?.clientCredentials) return "oauth2";
		// implicit / password flows: the user brings a token
		return "bearer";
	}
	if (s.type === "openIdConnect") return "bearer";
	return "none";
}
