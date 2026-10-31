export { parseSpec } from "./parser/index.js";
export { mapToMcpTools, extractWebhooks, detectAuth } from "./mapper/index.js";
export { generate } from "./generator/index.js";
export { adaptInputSchema, PROFILES } from "./schema/adapt.js";
export type { SchemaProfile, AdaptedSchema } from "./schema/adapt.js";
export { CLIENT_TARGETS } from "./types.js";
export type {
	McpToolDefinition,
	GenerateOptions,
	OpenApiSpec,
	MapperOptions,
	AuthMode,
	ClientTarget,
	PaginationConfig,
	PaginationHint,
	WebhookDefinition,
} from "./types.js";
