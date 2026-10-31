// Public OpenAPI specs used to test the generator on real-world input.
// Downloaded on demand into .cache/specs/ (git-ignored).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface SpecEntry {
	name: string;
	url: string;
	ext: "json" | "yaml";
	note?: string;
}

export const SPECS: SpecEntry[] = [
	{ name: "petstore3", url: "https://petstore3.swagger.io/api/v3/openapi.json", ext: "json", note: "relative server url /api/v3" },
	{ name: "webhook-example", url: "https://raw.githubusercontent.com/OAI/learn.openapis.org/main/examples/v3.1/webhook-example.yaml", ext: "yaml", note: "3.1, webhooks only, no paths ops" },
	{ name: "github", url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json", ext: "json" },
	{ name: "stripe", url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json", ext: "json" },
	{ name: "slack", url: "https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json", ext: "json", note: "Swagger 2.0" },
	{ name: "notion", url: "https://raw.githubusercontent.com/APIs-guru/openapi-directory/main/APIs/notion.com/1.0.0/openapi.yaml", ext: "yaml", note: "APIs.guru community spec (no official)" },
	{ name: "openai", url: "https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml", ext: "yaml", note: "3.1" },
	{ name: "twilio", url: "https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json", ext: "json" },
	{ name: "digitalocean", url: "https://api-engineering.nyc3.cdn.digitaloceanspaces.com/spec-ci/DigitalOcean-public.v2.yaml", ext: "yaml" },
	{ name: "discord", url: "https://raw.githubusercontent.com/discord/discord-api-spec/main/specs/openapi.json", ext: "json", note: "3.1" },
	{ name: "asana", url: "https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml", ext: "yaml" },
	{ name: "spotify", url: "https://raw.githubusercontent.com/sonallux/spotify-web-api/main/fixed-spotify-open-api.yml", ext: "yaml" },
	{ name: "jira", url: "https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json", ext: "json" },
	{ name: "box", url: "https://raw.githubusercontent.com/box/box-openapi/main/openapi.json", ext: "json" },
	{ name: "vercel", url: "https://openapi.vercel.sh/", ext: "json" },
	{ name: "launchdarkly", url: "https://app.launchdarkly.com/api/v2/openapi.json", ext: "json" },
	{ name: "pagerduty", url: "https://raw.githubusercontent.com/PagerDuty/api-schema/main/reference/REST/openapiv3.json", ext: "json" },
	{ name: "cloudflare", url: "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json", ext: "json", note: "~27MB" },
];

export const SPEC_DIR = resolve(import.meta.dir, "../.cache/specs");

/** Download any missing specs; returns the local file paths that exist afterwards. */
export async function ensureSpecs(names: string[] = []): Promise<Array<{ name: string; file: string }>> {
	mkdirSync(SPEC_DIR, { recursive: true });
	const wanted = names.length ? SPECS.filter((s) => names.includes(s.name)) : SPECS;
	const out: Array<{ name: string; file: string }> = [];
	for (const spec of wanted) {
		const file = join(SPEC_DIR, `${spec.name}.${spec.ext}`);
		if (!existsSync(file)) {
			try {
				const res = await fetch(spec.url, { headers: { "User-Agent": "openapi-mcp-codegen-tests" } });
				if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
				writeFileSync(file, Buffer.from(await res.arrayBuffer()));
			} catch (err) {
				console.error(`download failed: ${spec.name} (${(err as Error).message})`);
				continue;
			}
		}
		out.push({ name: spec.name, file });
	}
	return out;
}
