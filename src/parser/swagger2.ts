import type { OpenApiSpec } from "../types.js";

type Obj = Record<string, unknown>;

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch"];
const SCHEMA_KEYS = [
	"type",
	"format",
	"items",
	"enum",
	"default",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"minLength",
	"maxLength",
	"pattern",
	"minItems",
	"maxItems",
	"uniqueItems",
	"multipleOf",
];

/**
 * Convert a Swagger 2.0 document to the OpenAPI 3.0 shape the rest of the
 * pipeline expects. Covers what affects tool generation: servers, body and
 * formData parameters, response schemas, security definitions and $ref paths.
 */
export function convertSwagger2(doc: Obj): OpenApiSpec {
	const src = rewriteRefs(doc) as Obj;
	const globalParams = (src.parameters ?? {}) as Record<string, Obj>;
	const consumes = (src.consumes as string[] | undefined) ?? ["application/json"];
	const produces = (src.produces as string[] | undefined) ?? ["application/json"];

	const resolveParam = (p: Obj): Obj => {
		const ref = p.$ref;
		if (typeof ref === "string" && ref.startsWith("#/components/parameters/")) {
			return globalParams[decodeURIComponent(ref.slice("#/components/parameters/".length))] ?? p;
		}
		return p;
	};

	const paths: Record<string, Obj> = {};
	for (const [path, rawItem] of Object.entries((src.paths ?? {}) as Record<string, Obj>)) {
		if (!rawItem || typeof rawItem !== "object") continue;
		const item: Obj = {};
		const pathParams = ((rawItem.parameters ?? []) as Obj[]).map(resolveParam);
		if (pathParams.length) item.parameters = pathParams.filter(isSimpleParam).map(convertParam);
		for (const method of METHODS) {
			const op = rawItem[method] as Obj | undefined;
			if (!op || typeof op !== "object") continue;
			item[method] = convertOperation(op, pathParams, resolveParam, consumes, produces);
		}
		paths[path] = item;
	}

	const out: Obj = {
		openapi: "3.0.3",
		info: src.info ?? { title: "API", version: "1.0.0" },
		servers: buildServers(src),
		paths,
		components: {
			schemas: convertSchemas((src.definitions ?? {}) as Obj),
			parameters: Object.fromEntries(
				Object.entries(globalParams)
					.filter(([, p]) => isSimpleParam(p))
					.map(([k, p]) => [k, convertParam(p)]),
			),
			responses: Object.fromEntries(
				Object.entries((src.responses ?? {}) as Record<string, Obj>).map(([k, r]) => [k, convertResponse(r, produces)]),
			),
			securitySchemes: convertSecurity((src.securityDefinitions ?? {}) as Record<string, Obj>),
		},
	};
	if (src.security) out.security = src.security;
	if (src.tags) out.tags = src.tags;
	return out as unknown as OpenApiSpec;
}

function buildServers(src: Obj): Array<{ url: string }> {
	const basePath = typeof src.basePath === "string" ? src.basePath.replace(/\/$/, "") : "";
	if (typeof src.host !== "string" || !src.host) return basePath ? [{ url: basePath }] : [];
	const schemes = (src.schemes as string[] | undefined) ?? ["https"];
	const scheme = schemes.includes("https") ? "https" : schemes[0];
	return [{ url: `${scheme}://${src.host}${basePath}` }];
}

function convertOperation(
	op: Obj,
	pathParams: Obj[],
	resolveParam: (p: Obj) => Obj,
	globalConsumes: string[],
	globalProduces: string[],
): Obj {
	const consumes = (op.consumes as string[] | undefined) ?? globalConsumes;
	const produces = (op.produces as string[] | undefined) ?? globalProduces;
	const params = mergeByKey(pathParams, ((op.parameters ?? []) as Obj[]).map(resolveParam));
	const out: Obj = {};
	for (const [k, v] of Object.entries(op)) {
		if (["parameters", "responses", "consumes", "produces", "schemes"].includes(k)) continue;
		out[k] = v;
	}

	out.parameters = ((op.parameters ?? []) as Obj[]).map(resolveParam).filter(isSimpleParam).map(convertParam);

	const bodyParam = params.find((p) => p.in === "body");
	const formParams = params.filter((p) => p.in === "formData");
	if (bodyParam) {
		const types = consumes.filter((t) => !t.startsWith("multipart/") && t !== "application/x-www-form-urlencoded");
		const content: Obj = {};
		for (const t of types.length ? types : ["application/json"]) content[t] = { schema: bodyParam.schema ?? {} };
		out.requestBody = { required: bodyParam.required === true, description: bodyParam.description, content };
	} else if (formParams.length) {
		const hasFile = formParams.some((p) => p.type === "file");
		const mediaType =
			hasFile || (consumes.includes("multipart/form-data") && !consumes.includes("application/x-www-form-urlencoded"))
				? "multipart/form-data"
				: "application/x-www-form-urlencoded";
		const properties: Obj = {};
		const required: string[] = [];
		for (const p of formParams) {
			const schema = p.type === "file" ? { type: "string", format: "binary" } : pickSchema(p);
			if (p.description) (schema as Obj).description = p.description;
			properties[p.name as string] = schema;
			if (p.required) required.push(p.name as string);
		}
		out.requestBody = {
			required: required.length > 0,
			content: { [mediaType]: { schema: { type: "object", properties, ...(required.length ? { required } : {}) } } },
		};
	}

	const responses: Obj = {};
	for (const [code, r] of Object.entries((op.responses ?? {}) as Record<string, Obj>)) {
		responses[code] = convertResponse(r, produces);
	}
	out.responses = responses;
	return out;
}

function convertResponse(r: Obj, produces: string[]): Obj {
	if (!r || typeof r !== "object") return { description: "" };
	if (typeof r.$ref === "string") return { $ref: r.$ref };
	const out: Obj = { description: r.description ?? "" };
	if (r.schema) {
		const content: Obj = {};
		const types = produces.filter((t) => t.includes("json"));
		for (const t of types.length ? types : ["application/json"]) content[t] = { schema: r.schema };
		out.content = content;
	}
	return out;
}

function isSimpleParam(p: Obj): boolean {
	return p?.in !== "body" && p?.in !== "formData";
}

function convertParam(p: Obj): Obj {
	if (typeof p.$ref === "string") return p;
	const out: Obj = { name: p.name, in: p.in };
	if (p.description) out.description = p.description;
	if (p.required) out.required = true;
	out.schema = pickSchema(p);
	return out;
}

function pickSchema(p: Obj): Obj {
	const schema: Obj = {};
	for (const key of SCHEMA_KEYS) if (p[key] !== undefined) schema[key] = p[key];
	if (p["x-nullable"] === true) schema.nullable = true;
	if (!schema.type) schema.type = "string";
	return schema;
}

function convertSchemas(defs: Obj): Obj {
	return walk(defs, (node) => {
		if (node["x-nullable"] === true && node.nullable === undefined) node.nullable = true;
		if (node.type === "file") {
			node.type = "string";
			node.format = "binary";
		}
		return node;
	}) as Obj;
}

function convertSecurity(defs: Record<string, Obj>): Obj {
	const out: Obj = {};
	for (const [name, d] of Object.entries(defs)) {
		if (!d || typeof d !== "object") continue;
		if (d.type === "basic") {
			out[name] = { type: "http", scheme: "basic", description: d.description };
		} else if (d.type === "apiKey") {
			out[name] = { type: "apiKey", name: d.name, in: d.in, description: d.description };
		} else if (d.type === "oauth2") {
			const flowName =
				d.flow === "accessCode"
					? "authorizationCode"
					: d.flow === "application"
						? "clientCredentials"
						: (d.flow as string) ?? "implicit";
			const flow: Obj = { scopes: d.scopes ?? {} };
			if (d.authorizationUrl) flow.authorizationUrl = d.authorizationUrl;
			if (d.tokenUrl) flow.tokenUrl = d.tokenUrl;
			out[name] = { type: "oauth2", flows: { [flowName]: flow }, description: d.description };
		}
	}
	return out;
}

function mergeByKey(pathParams: Obj[], opParams: Obj[]): Obj[] {
	const map = new Map<string, Obj>();
	for (const p of [...pathParams, ...opParams]) map.set(`${p.in}:${p.name}`, p);
	return [...map.values()];
}

const REF_MAP: Array<[string, string]> = [
	["#/definitions/", "#/components/schemas/"],
	["#/parameters/", "#/components/parameters/"],
	["#/responses/", "#/components/responses/"],
];

function rewriteRefs(node: unknown): unknown {
	return walk(node, (obj) => {
		if (typeof obj.$ref === "string") {
			for (const [from, to] of REF_MAP) {
				if (obj.$ref.startsWith(from)) {
					obj.$ref = to + obj.$ref.slice(from.length);
					break;
				}
			}
		}
		return obj;
	});
}

function walk(node: unknown, fn: (obj: Obj) => Obj): unknown {
	if (Array.isArray(node)) return node.map((n) => walk(n, fn));
	if (node === null || typeof node !== "object") return node;
	const out: Obj = {};
	for (const [k, v] of Object.entries(node as Obj)) out[k] = walk(v, fn);
	return fn(out);
}
