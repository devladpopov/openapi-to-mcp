export interface OpenApiSpec {
	openapi: string;
	info: {
		title: string;
		version: string;
		description?: string;
	};
	servers?: Array<{ url: string; description?: string }>;
	paths: Record<string, PathItem>;
	components?: {
		schemas?: Record<string, JsonSchema>;
		securitySchemes?: Record<string, SecurityScheme>;
	};
}

export interface PathItem {
	get?: Operation;
	post?: Operation;
	put?: Operation;
	patch?: Operation;
	delete?: Operation;
	parameters?: Parameter[];
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
	"x-mcp-exclude"?: boolean;
	"x-mcp-name"?: string;
	"x-mcp-description"?: string;
}

export interface Parameter {
	name: string;
	in: "query" | "header" | "path" | "cookie";
	required?: boolean;
	description?: string;
	schema?: JsonSchema;
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
	type?: string;
	properties?: Record<string, JsonSchema>;
	items?: JsonSchema;
	required?: string[];
	description?: string;
	enum?: unknown[];
	format?: string;
	$ref?: string;
	allOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	anyOf?: JsonSchema[];
}

export interface SecurityScheme {
	type: "apiKey" | "http" | "oauth2" | "openIdConnect";
	name?: string;
	in?: "query" | "header" | "cookie";
	scheme?: string;
	flows?: Record<string, OAuthFlow>;
}

export interface OAuthFlow {
	authorizationUrl?: string;
	tokenUrl?: string;
	refreshUrl?: string;
	scopes?: Record<string, string>;
}

export interface McpToolDefinition {
	name: string;
	description: string;
	inputSchema: JsonSchema;
	meta: {
		method: string;
		path: string;
		tags: string[];
		auth: SecurityScheme | null;
	};
}

export interface MapperOptions {
	serverName?: string;
	includeTags?: string[];
	excludeTags?: string[];
	excludeOperations?: string[];
}

export interface GenerateOptions {
	tools: McpToolDefinition[];
	spec: OpenApiSpec;
	outputDir: string;
	serverName: string;
	transport: "stdio" | "streamable-http";
	auth: "none" | "api-key" | "bearer" | "oauth2";
}
