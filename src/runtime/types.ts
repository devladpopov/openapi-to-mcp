// Shared types for the generated MCP server runtime.

export type JsonSchema = {
	type?: string | string[];
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	required?: string[];
	enum?: unknown[];
	anyOf?: JsonSchema[];
	additionalProperties?: boolean | JsonSchema;
	description?: string;
	[key: string]: unknown;
};

/** [inputPropertyName, wireName] */
export type ParamPair = [string, string];

export interface PaginationSpec {
	type: "offset" | "page" | "cursor";
	limitParam: string;
	offsetParam?: string;
	pageParam?: string;
	cursorParam?: string;
	/** Dot path to the next cursor / total / items in the response; "" = auto-detect. */
	cursorPath: string;
	totalPath: string;
	itemsPath: string;
	defaultLimit: number;
}

export interface ToolSpec {
	name: string;
	title?: string;
	description: string;
	inputSchema: JsonSchema;
	annotations?: Record<string, unknown>;
	method: string;
	path: string;
	tags?: string[];
	pathParams: ParamPair[];
	queryParams: ParamPair[];
	headerParams: ParamPair[];
	bodyParams: ParamPair[];
	bodyMode: "none" | "fields" | "whole";
	bodyContentType: "json" | "form" | "multipart" | "text" | "binary";
	bodyMediaType?: string;
	pagination?: PaginationSpec | null;
	streaming?: boolean;
	requiresAuth?: boolean;
	/** Paths of values sent as JSON-encoded strings ("a.b", "*" = array item). */
	jsonArgs?: string[];
	/** Paths not validated because the advertised schema is narrower than the API (collapsed unions). */
	looseArgs?: string[];
	/** Untyped values sent as JSON strings ("42" -> 42, "true" -> true). */
	jsonAnyArgs?: string[];
	/** Query serialization by wire name; default: repeat arrays, deepObject for objects. */
	queryStyles?: Record<string, "csv" | "ssv" | "pipe" | "deep" | "flat">;
	/** Operation-specific server (e.g. an uploads host); used unless API_BASE_URL is set. */
	baseUrl?: string;
}

export interface WebhookSpec {
	name: string;
	slug: string;
	description: string;
	source: "webhook" | "callback";
	operation?: string;
	payloadFields: string[];
}

export interface ToolsFile {
	tools: ToolSpec[];
	webhooks: WebhookSpec[];
}

export type AuthMode = "none" | "api-key" | "bearer" | "basic" | "oauth2" | "oauth2-auth-code";

export interface AuthConfig {
	mode: AuthMode;
	apiKeyName?: string;
	apiKeyIn?: "header" | "query" | "cookie";
	authorizationUrl?: string;
	tokenUrl?: string;
	scopes?: string;
}

export interface RuntimeConfig {
	serverName: string;
	serverVersion: string;
	baseUrl: string;
	transport: "stdio" | "streamable-http";
	auth: AuthConfig;
	/** Client profile the schemas were adapted to (informational). */
	target: string;
	/** Treat null arguments as omitted (OpenAI strict mode sends null for optional fields). */
	nullAsAbsent: boolean;
}

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolResult {
	content: Array<TextContent | ImageContent>;
	isError?: boolean;
	[key: string]: unknown;
}
