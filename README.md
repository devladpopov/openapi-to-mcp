# openapi-mcp-codegen

Generate [MCP](https://modelcontextprotocol.io) servers from OpenAPI 3.x specifications. One command, working server.

```bash
npx openapi-mcp-codegen generate -i petstore.yaml -o ./mcp-server
cd mcp-server && npm install && npm start
```

The generated server works with Claude Desktop, Claude Code, Cursor, VS Code Copilot, ChatGPT, Gemini CLI, and any other MCP-compatible client.

## What it does

Takes an OpenAPI 3.x spec (YAML or JSON) and produces a TypeScript MCP server where each API operation becomes an MCP tool with:

- Zod-validated input schema derived from parameters and request body
- Proper path interpolation and query string building
- Auth handling (API key, Bearer, OAuth2 client credentials, OAuth2 authorization code + PKCE)
- Automatic pagination (cursor-based wrapper for offset/page/cursor APIs)
- Streaming response support (SSE, NDJSON)
- `$ref` resolution (inlined at build time for maximum client compatibility)
- Streamable HTTP transport (in addition to stdio)

## Quick start

```bash
# From a local file
npx openapi-mcp-codegen generate -i api-spec.yaml -o ./my-server

# From a URL
npx openapi-mcp-codegen generate -i https://petstore3.swagger.io/api/v3/openapi.json -o ./petstore

# Preview tools without generating (dry run)
npx openapi-mcp-codegen generate -i spec.yaml --dry-run

# Generate with Streamable HTTP transport
npx openapi-mcp-codegen generate -i spec.yaml -o ./server --transport streamable-http
```

### Use with Claude Desktop

Add the generated server to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "my-api": {
      "command": "node",
      "args": ["path/to/mcp-server/dist/server.js"],
      "env": {
        "API_BASE_URL": "https://api.example.com",
        "API_KEY": "your-key"
      }
    }
  }
}
```

### Use with Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "my-api": {
      "command": "node",
      "args": ["path/to/mcp-server/dist/server.js"],
      "env": {
        "API_BASE_URL": "https://api.example.com",
        "API_KEY": "your-key"
      }
    }
  }
}
```

## CLI options

```
openapi-mcp-codegen generate [options]

Options:
  -i, --input <path>         Path or URL to OpenAPI spec (required)
  -o, --output <dir>         Output directory (default: ./mcp-server)
  -n, --name <name>          Server name (default: spec title)
  --transport <type>         stdio | streamable-http (default: stdio)
  --auth <type>              none | api-key | bearer | oauth2 | oauth2-auth-code
                             (default: auto-detect from spec)
  --include-tags <tags>      Only include operations with these tags (comma-separated)
  --exclude-tags <tags>      Exclude operations with these tags (comma-separated)
  --dry-run                  Print tool definitions as JSON without generating
```

## Auth

Auth is auto-detected from the spec's `securitySchemes` when `--auth` is not set. If the spec has an `authorizationCode` flow, it auto-selects `oauth2-auth-code`.

| Mode | Env vars | Description |
|------|----------|-------------|
| `none` | - | No authentication |
| `api-key` | `API_KEY` | API key sent in the header defined in spec (e.g. `X-API-Key`) |
| `bearer` | `API_TOKEN` | Bearer token in `Authorization` header |
| `oauth2` | `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_TOKEN_URL` | Client credentials grant with token caching |
| `oauth2-auth-code` | `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_AUTH_URL`, `OAUTH_TOKEN_URL`, `OAUTH_SCOPES` | Authorization code + PKCE with local callback server, automatic token refresh |

### OAuth2 Authorization Code + PKCE

When using `oauth2-auth-code`, the generated server:

1. Starts a temporary local HTTP server on port 8976 (configurable via `OAUTH_REDIRECT_PORT`)
2. Prints an authorization URL to stderr
3. Waits for the OAuth callback with the authorization code
4. Exchanges the code for tokens using PKCE (S256 challenge)
5. Automatically refreshes tokens when they expire
6. Falls back to re-authorization if refresh fails

This is the recommended mode for APIs that require user authentication (Google, GitHub, Slack, etc.).

## Pagination

Pagination is auto-detected from parameter names in GET endpoints:

| Pattern | Detection | Example params |
|---------|-----------|----------------|
| Offset-based | `limit` + `offset`/`skip` | `?limit=20&offset=40` |
| Page-based | `per_page`/`page_size` + `page` | `?per_page=20&page=3` |
| Cursor-based | `limit` + `cursor`/`after`/`starting_after` | `?limit=20&after=abc123` |

When pagination is detected, the generated tool:
- Replaces raw offset/page params with an opaque `cursor` parameter
- Adds a `limit` parameter
- Returns `{ items, has_more, next_cursor, total }` in the response
- Encodes/decodes cursor state as base64url

You can also explicitly configure pagination with vendor extensions:

```yaml
paths:
  /messages:
    get:
      x-mcp-pagination:
        type: offset
        limitParam: count
        offsetParam: skip
        itemsPath: data
        totalPath: total_count
```

## Streaming

Endpoints that return `text/event-stream`, `application/x-ndjson`, or `application/stream+json` are automatically detected and handled with a streaming reader that collects all chunks before returning.

## Vendor extensions

Control how operations are mapped to MCP tools:

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
        Returns up to 100 results.

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
  src/
    server.ts       # MCP server with all tool definitions
  package.json      # Dependencies: @modelcontextprotocol/sdk, zod
  tsconfig.json     # TypeScript config
  .env.example      # Environment variables template
```

Build and run:

```bash
cd mcp-server
npm install
npm run build
npm start
```

Or with environment variables:

```bash
API_BASE_URL=https://api.example.com API_KEY=xxx npm start
```

## How it works

1. **Parser** loads the spec (file or URL), validates OpenAPI 3.x, resolves all `$ref` inline. Inline resolution is required because some MCP clients (Claude Code, Amazon Bedrock) don't handle `$ref` in tool schemas.

2. **Mapper** converts each operation to an MCP tool definition. Parameters (path, query) and request body properties are flattened into a single input schema. Auth requirements are extracted from security schemes. Pagination patterns are auto-detected from parameter names and response schemas. Streaming content types are flagged.

3. **Generator** renders a TypeScript file with MCP SDK imports, Zod schemas, auth helpers (including full OAuth2 PKCE flow), pagination cursor encode/decode, and transport setup (stdio or Streamable HTTP). Outputs a complete project with `package.json` and `tsconfig.json`.

## Programmatic API

```typescript
import { parseSpec, mapToMcpTools, generate } from "openapi-mcp-codegen";

const spec = await parseSpec("./api-spec.yaml");
const tools = mapToMcpTools(spec, {
  includeTags: ["public"],
  excludeOperations: ["deprecated_endpoint"],
  detectPagination: true,  // default: true
});

await generate({
  tools,
  spec,
  outputDir: "./output",
  serverName: "My API",
  transport: "stdio",
  auth: "oauth2-auth-code",
});
```

## Roadmap

- [x] OAuth2 Authorization Code + PKCE
- [x] Cursor-based pagination wrapper (offset, page, cursor)
- [x] Streaming response handling (SSE, NDJSON)
- [x] Streamable HTTP transport
- [ ] Workflow grouping (merge related endpoints into composite tools)
- [ ] Multi-client schema adaptation (Claude vs Bedrock vs GPT)
- [ ] MCP 2026-07-28 spec support (stateless)
- [ ] Pre-built presets for popular APIs (Stripe, GitHub, Notion)
- [ ] npm publish

## Contributing

PRs welcome. Please open an issue first to discuss non-trivial changes.

## License

MIT
