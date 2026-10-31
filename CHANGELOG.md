# Changelog

## 0.3.0

### Added

- `--target generic | claude | openai | gemini | cursor | bedrock | portable`: adapts tool input schemas to each client's JSON Schema subset (OpenAI strict mode, Gemini's OpenAPI subset, Bedrock without unions, Cursor's 60-character names, or all at once with `portable`).
- Webhooks: OpenAPI 3.1 `webhooks` and 3.0 `callbacks` generate a receiver (HMAC verification for GitHub, Stripe, Slack and generic signatures) plus `webhooks_list_types`, `webhooks_get_events` and `webhooks_wait_for_event`. The wait tool supports MCP Tasks; a `webhook://events` resource notifies subscribers.
- Swagger 2.0 input (converted to OpenAPI 3: body/formData parameters, security definitions, `$ref` paths).
- `basic` auth mode; API keys sent in query or cookie when the spec says so; `OAUTH_ACCESS_TOKEN` to skip the browser flow.
- Header parameters (e.g. `Idempotency-Key`, `LD-API-Version`) as tool inputs.
- Request bodies: `+json` media types, multipart/form-data (files as `base64:` strings), text and binary.
- Query serialization per OpenAPI `style`/`explode`: repeated arrays, comma/space/pipe-delimited, `deepObject`.
- Operation- and path-level `servers` (e.g. GitHub's uploads host), server variable defaults, relative server URLs resolved against the spec URL.
- Tool annotations from the HTTP method, tool titles, summary + description in tool descriptions.
- Runtime switches: `MCP_READ_ONLY`, `MCP_TOOLS_INCLUDE` / `MCP_TOOLS_EXCLUDE`, `MCP_TRANSPORT`, `API_EXTRA_HEADERS`, `API_TIMEOUT_MS`, `MAX_RESPONSE_CHARS`.
- `--exclude-deprecated`, `--no-webhooks`; warnings when the tool count exceeds a client's limit.
- `bun run test:real-specs`: checks 18 public specs against every target.

### Changed

- Generated servers are now data plus a fixed runtime: `tools.json` holds the tool definitions and `src/*.ts` is the same tested runtime for every API (low-level MCP `Server`, no per-tool generated code). The GitHub spec compiles in seconds instead of 35 s / 570 MB.
- Auth detection ranks the spec's security requirements instead of taking the first scheme (Stripe gets bearer instead of none, Cloudflare its API token).
- Streamable HTTP is stateless with a fresh server per request, so several clients can connect; `/health` endpoint added.
- Tool names keep `-` and may use the full 64 characters.

### Security

- Streamable HTTP binds to `127.0.0.1` by default, checks `Host`/`Origin` against localhost plus `MCP_ALLOWED_HOSTS`, and supports a bearer token (`MCP_AUTH_TOKEN`).
- Redirects no longer carry API keys or credentials to another origin.
- Path parameters are percent-encoded (no `../` traversal into other endpoints).
- Webhooks: replay window for Stripe/Slack timestamps (`WEBHOOK_TOLERANCE_SECONDS`), byte cap on the event buffer (`WEBHOOK_BUFFER_BYTES`), warning when `WEBHOOK_SECRET` is unset.
- OAuth callback server listens on `127.0.0.1` only.

### Fixed

- HTTP errors are returned as `isError` results with the status code; large responses are truncated; 429/503 are retried.
- Cursor pagination works with real APIs (`data` + `has_more` + last id, `next_page_token`, Link headers) and no longer drops the user's cursor parameter; pagination is only applied to GET.
- Streaming endpoints send their request body and query; endpoints that can also answer with JSON are not forced into streaming.
- Nested `allOf`, single-part `allOf`, `const`, nullable unions (`anyOf: [X, {type: null}]`), untyped schemas and unions with more than 5 variants are mapped correctly.
- Property keys like `filter[status]`, `$top` or `EndTime>` are renamed to valid keys and sent under their original names.
- `readOnly` properties are no longer requested as input; empty request bodies on GET are ignored.
- Operations with `security: []` do not require or send credentials.
- Credential parameters (`token`, the apiKey scheme's own parameter) are not exposed to the model.
- Patterns invalid in unicode mode are dropped instead of breaking schema validation.

## 0.2.0

- OAuth2 authorization code + PKCE, pagination, streaming, dual ESM/CJS build, published as `openapi-mcp-codegen`.
