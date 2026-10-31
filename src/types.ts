export interface OpenApiSpec {
	openapi: string;
	info: {
		title: string;
		version: string;
		description?: string;
	};
	servers?: ServerObject[];
	paths: Record<string, PathItem>;
	/** OpenAPI 3.1 top-level webhooks: name -> path item describing the incoming request. */
	webhooks?: Record<string, PathItem>;
	components?: {
		schemas?: Record<string, JsonSchema>;
		securitySchemes?: Record<string, SecurityScheme>;
		[key: string]: unknown;
	};
	security?: Array<Record<string, string[]>>;
}

export interface ServerObject {
	url: string;
	description?: string;
	variables?: Record<string, { default: string; enum?: string[]; description?: string }>;
}

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface PathItem {
	get?: Operation;
	post?: Operation;
	put?: Operation;
	patch?: Operation;
	delete?: Operation;
	head?: Operation;
	options?: Operation;
	parameters?: Parameter[];
	servers?: ServerObject[];
	summary?: string;
	description?: string;
}

export interface Operation {
	operationId?: string;
	summary?: string;
	description?: string;
	tags?: string[];
	parameters?: Parameter[];
	requestBody?: RequestBody;
	responses?: Record<string, Response>;
	security?: Array<Record<string, string[]>>;
	deprecated?: boolean;
	/** OpenAPI 3.0 callbacks: name -> { runtimeExpression -> PathItem }. */
	callbacks?: Record<string, Record<string, PathItem>>;
	servers?: ServerObject[];
	"x-mcp-exclude"?: boolean;
	"x-mcp-name"?: string;
	"x-mcp-description"?: string;
	"x-mcp-pagination"?: PaginationHint;
}

export interface PaginationHint {
	type: "offset" | "page" | "cursor";
	limitParam?: string;
	offsetParam?: string;
	pageParam?: string;
	cursorParam?: string;
	cursorPath?: string;
	totalPath?: string;
	itemsPath?: string;
}

export interface Parameter {
	name: string;
	in: "query" | "header" | "path" | "cookie";
	required?: boolean;
	description?: string;
	deprecated?: boolean;
	schema?: JsonSchema;
	content?: Record<string, MediaType>;
	style?: string;
	explode?: boolean;
}

export interface RequestBody {
	required?: boolean;
	description?: string;
	content: Record<string, MediaType>;
}

export interface MediaType {
	schema?: JsonSchema;
}

export interface Response {
	description?: string;
	content?: Record<string, MediaType>;
}

export interface JsonSchema {
	type?: string | string[];
	title?: string;
	properties?: Record<string, JsonSchema>;
	additionalProperties?: boolean | JsonSchema;
	items?: JsonSchema;
	required?: string[];
	description?: string;
	enum?: unknown[];
	const?: unknown;
	format?: string;
	nullable?: boolean;
	default?: unknown;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	minItems?: number;
	maxItems?: number;
	pattern?: string;
	readOnly?: boolean;
	writeOnly?: boolean;
	deprecated?: boolean;
	$ref?: string;
	allOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	anyOf?: JsonSchema[];
	[key: string]: unknown;
}

export interface SecurityScheme {
	type: "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTLS";
	name?: string;
	in?: "query" | "header" | "cookie";
	scheme?: string;
	flows?: Record<string, OAuthFlow>;
	openIdConnectUrl?: string;
}

export interface OAuthFlow {
	authorizationUrl?: string;
	tokenUrl?: string;
	refreshUrl?: string;
	scopes?: Record<string, string>;
}

/** Pairs of [inputPropertyName, wireName]. */
export type ParamPair = [string, string];

export interface McpToolDefinition {
	name: string;
	/** Human-readable title (MCP 2025-06-18+). */
	title?: string;
	description: string;
	inputSchema: JsonSchema;
	annotations?: ToolAnnotations;
	meta: {
		method: string;
		path: string;
		tags: string[];
		auth: SecurityScheme | null;
		/** False when the operation explicitly opts out of auth (`security: []`). */
		requiresAuth: boolean;
		pagination: PaginationConfig | null;
		streaming: boolean;
		pathParams: ParamPair[];
		queryParams: ParamPair[];
		headerParams: ParamPair[];
		/** Pairs of [inputPropertyName, requestBodyFieldName]; ["x", "*"] = whole body. */
		bodyParams: ParamPair[];
		/** "fields": body assembled from bodyParams; "whole": a single property sent as-is. */
		bodyMode: "none" | "fields" | "whole";
		/** How the request body is serialized on the wire. */
		bodyContentType: "json" | "form" | "multipart" | "text" | "binary";
		/** Raw media type sent as Content-Type (e.g. application/vnd.api+json). */
		bodyMediaType?: string;
		/** Top-level inputs the client sends as JSON-encoded strings (schema adaptation). */
		jsonArgs?: string[];
		/** Paths below which runtime validation is skipped (collapsed unions). */
		looseArgs?: string[];
		/** Non-default query serialization by wire name (OpenAPI style/explode). */
		queryStyles?: Record<string, QueryStyle>;
		/** Operation- or path-level server overriding the global base URL. */
		baseUrl?: string;
	};
}

/** csv/ssv/pipe: delimited arrays (explode: false); deep: a[b]=c; flat: b=c. */
export type QueryStyle = "csv" | "ssv" | "pipe" | "deep" | "flat";

export interface ToolAnnotations {
	title?: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface PaginationConfig {
	type: "offset" | "page" | "cursor";
	limitParam: string;
	offsetParam?: string;
	pageParam?: string;
	cursorParam?: string;
	cursorPath: string;
	totalPath: string;
	itemsPath: string;
	defaultLimit: number;
}

export interface WebhookDefinition {
	/** Event name as declared in the spec (webhook key or callback name). */
	name: string;
	/** URL-safe slug used for the receiver route: /webhooks/<slug>. */
	slug: string;
	description: string;
	source: "webhook" | "callback";
	/** For callbacks: the operationId that registers the callback. */
	operation?: string;
	/** Top-level payload field names, as a hint for the LLM. */
	payloadFields: string[];
}

/**
 * Client profile that the generated tool schemas are adapted to. Each client
 * accepts a different subset of JSON Schema; see src/schema/adapt.ts.
 */
export const CLIENT_TARGETS = [
	"generic",
	"claude",
	"openai",
	"gemini",
	"cursor",
	"bedrock",
	"portable",
] as const;
export type ClientTarget = (typeof CLIENT_TARGETS)[number];

export interface MapperOptions {
	serverName?: string;
	includeTags?: string[];
	excludeTags?: string[];
	excludeOperations?: string[];
	detectPagination?: boolean;
	/** Skip operations marked `deprecated: true`. */
	excludeDeprecated?: boolean;
	/** Adapt schemas to the constraints of a specific MCP client. Default: generic. */
	target?: ClientTarget;
}

export type AuthMode =
	| "none"
	| "api-key"
	| "bearer"
	| "basic"
	| "oauth2"
	| "oauth2-auth-code";

export interface GenerateOptions {
	tools: McpToolDefinition[];
	spec: OpenApiSpec;
	outputDir: string;
	serverName: string;
	transport: "stdio" | "streamable-http";
	auth: AuthMode;
	/** Webhook/callback events to expose via a receiver + polling/Tasks tools. */
	webhooks?: WebhookDefinition[];
	target?: ClientTarget;
}
