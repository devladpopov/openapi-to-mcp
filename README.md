# openapi-mcp-codegen

Generate [MCP](https://modelcontextprotocol.io) servers from OpenAPI 3.x and Swagger 2.0 specifications. One command, working server.

```bash
npx openapi-mcp-codegen generate -i petstore.yaml -o ./mcp-server
cd mcp-server && npm install && npm run build && npm start
```

The generated server works with Claude Desktop, Claude Code, Cursor, VS Code Copilot, ChatGPT, OpenAI Codex, Gemini CLI, and any other MCP client. Tool schemas can be adapted to what each client accepts (`--target`).

## What it does

Takes an OpenAPI spec (YAML or JSON, file or URL) and produces a TypeScript MCP server where each API operation becomes an MCP tool:

- Input schema built from path, query and header parameters plus the request body (JSON, form-encoded, multipart, text or binary)
- **Client-specific schema adaptation**: one flag makes the schemas pass OpenAI strict mode, Gemini's OpenAPI subset, Bedrock, or Cursor's name limits ([details](#client-targets))
- **Webhooks via MCP Tasks**: OpenAPI 3.1 `webhooks` and 3.0 `callbacks` become a receiver plus tools the model can poll or wait on ([details](#webhooks))
- Auth: API key (header, query or cookie), Bearer, Basic, OAuth2 client credentials, OAuth2 authorization code + PKCE. Detected from the spec's security requirements.
- Pagination (offset, page, cursor) behind a single opaque `cursor` argument, including Stripe-style `has_more` + `starting_after` and Link headers
- Streaming responses (SSE, NDJSON)
- Lenient argument validation: `"5"` for an integer or a JSON string for an object are coerced, real mistakes come back as tool errors with the exact path
- HTTP errors returned as `isError` results with status and body; large responses truncated; 429/503 retried with `Retry-After`
- Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) from the HTTP method
- stdio and stateless Streamable HTTP transports

Tested against 18 public specs (GitHub, Stripe, Slack, OpenAI, Twilio, Cloudflare, DigitalOcean, Discord, Jira, Asana, Box, Spotify, Vercel, LaunchDarkly, PagerDuty, Notion, Petstore and a 3.1 webhook example) for every client target, see [Testing](#testing).

## Quick start

```bash
# From a local file
npx openapi-mcp-codegen generate -i api-spec.yaml -o ./my-server

# From a URL
npx openapi-mcp-codegen generate -i https://petstore3.swagger.io/api/v3/openapi.json -o ./petstore

# Only some endpoints, adapted for Gemini
npx openapi-mcp-codegen generate -i github.json -o ./github --include-tags repos,issues --target gemini

# Preview tools without generating (dry run)
npx openapi-mcp-codegen generate -i spec.yaml --dry-run

# Streamable HTTP transport
npx openapi-mcp-codegen generate -i spec.yaml -o ./server --transport streamable-http
```

### Use with Claude Code

```bash
claude mcp add my-api -e API_BASE_URL=https://api.example.com -e API_TOKEN=xxx -- node /path/to/mcp-server/dist/server.js
```

### Use with Claude Desktop, Cursor, Gemini CLI

`claude_desktop_config.json`, `.cursor/mcp.json` or `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "my-api": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/server.js"],
      "env": {
        "API_BASE_URL": "https://api.example.com",
        "API_TOKEN": "your-token"
      }
    }
  }
}
```

The generated project has its own README with ready-to-paste snippets for each client, including VS Code and Codex CLI.

## CLI options

```
openapi-mcp-codegen generate [options]

Options:
  -i, --input <path>         Path or URL to OpenAPI spec (required)
  -o, --output <dir>         Output directory (default: ./mcp-server)
  -n, --name <name>          Server name (default: spec title)
  --transport <type>         stdio | streamable-http (default: stdio)
  --auth <type>              none | api-key | bearer | basic | oauth2 | oauth2-auth-code
                             (default: auto-detect from spec)
  --target <client>          generic | claude | openai | gemini | cursor | bedrock | portable
                             (default: generic)
  --include-tags <tags>      Only include operations with these tags (comma-separated)
  --exclude-tags <tags>      Exclude operations with these tags (comma-separated)
  --exclude-deprecated       Skip operations marked deprecated
  --no-webhooks              Do not generate the webhook receiver and tools
  --dry-run                  Print tool definitions as JSON without generating
```

## Client targets

MCP clients pass tool schemas to their model provider, and providers accept different subsets of JSON Schema. A server that works in Claude can fail to load in another client with errors like `Invalid schema for function`, `Unknown name "additionalProperties"` or `properties: should be non-empty for OBJECT type`. `--target` adapts every input schema at generation time:

| Target | What changes |
|---|---|
| `generic` (default), `claude` | Full JSON Schema: `anyOf` unions, nullable type arrays, maps, formats, constraints |
| `openai` | Strict-mode compatible: every object closed (`additionalProperties: false`) with all properties required, optional fields nullable (nulls are dropped before the request), no `oneOf`, free-form objects and untyped values sent as JSON strings, supported formats only, descriptions up to 1024 chars |
| `gemini` | OpenAPI subset: no unions (variants merged into one shape), no `additionalProperties`, `const` or type arrays, string-only enums (others listed in the description), free-form objects as JSON strings, tool names start with a letter |
| `bedrock` | No `anyOf` / `oneOf` / `allOf` |
| `cursor` | Server name + tool name fit in 60 characters; warns above 40 tools |
| `portable` | Intersection of all of the above: one server that loads everywhere |

Always applied, for every target: `$ref` inlined, `allOf` merged, `readOnly` fields removed from inputs, vendor extensions and examples dropped, property keys made valid for Anthropic's `^[a-zA-Z0-9_.-]{1,64}$` (`filter[status]` becomes `filter_status`, sent as `filter[status]`), tool names unique and at most 64 characters, oversized schemas reduced in depth.

When a target collapses a union, the runtime still accepts every original variant, and JSON-string fields are parsed back before the request, so adaptation never breaks a call the API would accept.

## Webhooks

MCP has no way for a server to start a conversation, so webhook events are buffered and handed to the model through tools. For specs with OpenAPI 3.1 `webhooks` or operation `callbacks` (OpenAI declares 30, PagerDuty uses callbacks), the generated server:

- runs a receiver at `http://localhost:8787/webhooks/<event>` (stdio mode, `WEBHOOK_PORT`) or under `/webhooks` of the HTTP server (streamable-http mode)
- verifies HMAC signatures when `WEBHOOK_SECRET` is set (GitHub `X-Hub-Signature-256`, Stripe `Stripe-Signature`, Slack `X-Slack-Signature`, generic `X-Signature`), and answers Slack's `url_verification` handshake
- exposes `webhooks_list_types`, `webhooks_get_events` and `webhooks_wait_for_event`
- supports **MCP Tasks** for `webhooks_wait_for_event`: a task-aware client gets a task handle immediately, keeps working, and collects the event with `tasks/result` when it arrives. Clients without Tasks support get a normal long-poll call.
- publishes a `webhook://events` resource and sends `notifications/resources/updated` to subscribers

Point the provider at your public URL (ngrok, cloudflared) and set `WEBHOOK_PUBLIC_URL` so `webhooks_list_types` reports the right address.

## Auth

Auth is detected from the spec when `--auth` is not set. Security requirement alternatives are ranked: single-scheme requirements first, and simpler credentials win (bearer > API key > basic > OAuth2). Stripe gets `bearer`, Cloudflare gets its API token, Twilio and Jira get `basic`. Operations with `security: []` never send credentials.

| Mode | Env vars | Description |
|------|----------|-------------|
| `none` | - | No authentication |
| `api-key` | `API_KEY`, optional `API_KEY_PREFIX` | Key sent where the spec says: header, query or cookie |
| `bearer` | `API_TOKEN` | `Authorization: Bearer` |
| `basic` | `API_USERNAME`, `API_PASSWORD` | HTTP Basic |
| `oauth2` | `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_TOKEN_URL`, `OAUTH_SCOPES` | Client credentials grant with token caching |
| `oauth2-auth-code` | `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_AUTH_URL`, `OAUTH_TOKEN_URL`, `OAUTH_SCOPES` | Authorization code + PKCE with a local callback server and automatic refresh. `OAUTH_ACCESS_TOKEN` skips the browser flow. |

Credential parameters declared in the spec (an apiKey scheme's own header or query parameter, Slack's `token` header) are never exposed to the model.

## Runtime configuration

The generated server reads these at startup:

| Variable | Purpose |
|---|---|
| `API_BASE_URL` | Override the server URL from the spec (per-operation servers are used unless this is set) |
| `API_EXTRA_HEADERS` | JSON object of headers sent with every request, e.g. `{"Notion-Version":"2022-06-28"}` |
| `MCP_READ_ONLY=true` | Expose GET operations only |
| `MCP_TOOLS_INCLUDE`, `MCP_TOOLS_EXCLUDE` | Comma-separated tool names, tags or globs (`repos_*,issues`) |
| `MCP_TRANSPORT`, `PORT` | Switch to `streamable-http` without regenerating |
| `HOST` | Interface for streamable HTTP, default `127.0.0.1` |
| `MCP_AUTH_TOKEN` | Require `Authorization: Bearer <token>` on `/mcp` |
| `MCP_ALLOWED_HOSTS` | Extra `Host`/`Origin` names accepted besides localhost (comma-separated) |
| `MCP_TASKS` | `all` to offer Tasks for every tool, `off` to disable |
| `API_TIMEOUT_MS`, `MAX_RESPONSE_CHARS`, `API_MAX_RETRIES` | Request timeout, response truncation, retry count |
| `WEBHOOK_PORT`, `WEBHOOK_HOST`, `WEBHOOK_PUBLIC_URL`, `WEBHOOK_SECRET` | Webhook receiver (stdio mode) and signature verification |
| `WEBHOOK_TOLERANCE_SECONDS`, `WEBHOOK_BUFFER_SIZE`, `WEBHOOK_BUFFER_BYTES` | Replay window for signed timestamps (300), buffered event count (500) and total size (50 MB) |

### Security

The generated server holds your API credentials, so it is locked down by default:

- Streamable HTTP binds to `127.0.0.1` and rejects requests whose `Host` or `Origin` is not localhost (DNS rebinding). To expose it, set `HOST=0.0.0.0`, list your hostname in `MCP_ALLOWED_HOSTS` and set `MCP_AUTH_TOKEN`; the server warns at startup if it is reachable without a token.
- Redirects are followed manually and credentials are dropped when a redirect leaves the original origin.
- Path parameters are percent-encoded, so `../` cannot escape the operation path.
- Webhook signatures are compared in constant time, Stripe/Slack timestamps older than `WEBHOOK_TOLERANCE_SECONDS` are rejected, and the event buffer is capped by count and bytes. Without `WEBHOOK_SECRET` signatures are not verified (a warning is printed).
- The OAuth callback listens on `127.0.0.1` only.

## Pagination

Detected from query parameter names on GET operations:

| Pattern | Example params |
|---------|----------------|
| Offset | `limit` + `offset` / `skip` |
| Page | `per_page` / `page_size` + `page` |
| Cursor | `limit` + `cursor` / `after` / `starting_after` / `page_token` |

Paginated tools take `cursor` and `limit` and return `{ items, has_more, next_cursor, total }`. Items, totals and next cursors are found automatically (`data`, `results`, `next_page_token`, `response_metadata.next_cursor`, `has_more` + last item id, Link headers), or configured with `x-mcp-pagination`.

## Vendor extensions

```yaml
paths:
  /internal/health:
    get:
      x-mcp-exclude: true          # Skip this operation entirely

  /users:
    get:
      x-mcp-name: search_users     # Override the tool name
      x-mcp-description: |         # Override the tool description
        Search users by name or email.

  /messages:
    get:
      x-mcp-pagination:            # Explicit pagination config
        type: offset
        limitParam: count
        offsetParam: skip
        itemsPath: data
        totalPath: total_count
```

## Generated output

```
mcp-server/
  tools.json        # Tool definitions: schemas, routing, pagination (editable)
  src/
    config.ts       # Server name, base URL, auth mode, target
    server.ts       # MCP wiring: tools/list, tools/call, Tasks, resources, transports
    http.ts         # Request building, pagination, streaming, response handling
    auth.ts         # Auth modes incl. OAuth2 PKCE
    validate.ts     # Argument validation and coercion
    webhooks.ts     # Webhook receiver, store and tools
  package.json, tsconfig.json, .env.example, README.md
```

The runtime is the same for every API and is covered by this repo's tests; only `tools.json` and `config.ts` are spec-specific. Large APIs therefore compile in seconds (the GitHub spec produces 1254 tools), and you can tweak descriptions or drop tools in `tools.json` without regenerating.

## Programmatic API

```typescript
import { parseSpec, mapToMcpTools, extractWebhooks, detectAuth, generate } from "openapi-mcp-codegen";

const spec = await parseSpec("./api-spec.yaml");
const tools = mapToMcpTools(spec, {
  includeTags: ["public"],
  excludeOperations: ["deprecated_endpoint"],
  target: "openai",
});

await generate({
  tools,
  spec,
  outputDir: "./output",
  serverName: "My API",
  transport: "stdio",
  auth: detectAuth(spec),
  webhooks: extractWebhooks(spec),
  target: "openai",
});
```

`adaptInputSchema(schema, PROFILES.gemini)` is exported too, if you only need the schema adaptation.

## Testing

```bash
bun test                    # unit + e2e (generates a server, installs deps, compiles it,
                            # drives it with the MCP client over stdio and HTTP, incl. Tasks)
bun run test:real-specs     # downloads 18 public specs and checks every target's schema
                            # rules, ajv validity and a request dry-run for every tool
```

## Roadmap

- [x] OAuth2 Authorization Code + PKCE
- [x] Pagination wrapper (offset, page, cursor)
- [x] Streaming responses (SSE, NDJSON)
- [x] Streamable HTTP transport (stateless)
- [x] Multi-client schema adaptation (Claude, OpenAI, Gemini, Bedrock, Cursor)
- [x] Webhooks and callbacks via MCP Tasks
- [x] Swagger 2.0 input
- [ ] Workflow grouping (merge related endpoints into composite tools)
- [ ] Pre-built presets for popular APIs (Stripe, GitHub, Notion)

## Contributing

PRs welcome. Please open an issue first to discuss non-trivial changes. After editing anything in `src/runtime/`, run `bun run embed` (CI checks that the embedded copy is current).

## License

MIT
