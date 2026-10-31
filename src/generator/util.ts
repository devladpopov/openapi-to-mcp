import type { OpenApiSpec } from "../types.js";

export const GENERATOR_VERSION = "0.3.0";

export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

export function defaultBaseUrl(spec: OpenApiSpec): string {
	// Relative or still-templated URLs cannot be used as-is; API_BASE_URL must be set.
	const url = spec.servers?.find((s) => /^https?:\/\//.test(s.url))?.url ?? "";
	return url.includes("{") ? "" : url;
}
