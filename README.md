# openapi-to-mcp

Generate [MCP](https://modelcontextprotocol.io) servers from OpenAPI 3.x specifications. One command, working server.

```bash
npx openapi-to-mcp generate -i petstore.yaml -o ./mcp-server
cd mcp-server && npm install && npm start
```

The generated server works with Claude Desktop, Claude Code, Cursor, VS Code Copilot, ChatGPT, Gemini CLI, and any other MCP-compatible client.

## What it does

Takes an OpenAPI 3.x spec (YAML or JSON) and produces a TypeScript MCP server where each API operation becomes an MCP tool with:

- Zod-validated input schema derived from parameters and request body
- Proper path interpolation and query string building
- Auth handling (API key, Bearer, OAuth2 client credentials)
- `$ref` resolution (inlined at build time for maximum client compatibility)

## Quick start

```bash
# From a local file
npx openapi-to-mcp generate -i api-spec.yaml -o ./my-server

# From a URL
npx openapi-to-mcp generate -i https://petstore3.swagger.io/api/v3/openapi.json -o ./petstore

# Preview tools without generating (dry run)
npx openapi-to-mcp generate -i spec.yaml --dry-run
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
openapi-to-mcp generate [options]

Options:
  -i, --input <path>         Path or URL to OpenAPI spec (required)
  -o, --output <dir>         Output directory (default: ./mcp-server)
  -n, --name <name>          Server name (default: spec title)
  --transport <type>         stdio | streamable-http (default: stdio)
  --auth <type>              none | api-key | bearer | oauth2 (default: auto-detect)
  --include-tags <tags>      Only include operations with these tags (comma-separated)
  --exclude-tags <tags>      Exclude operations with these tags (comma-separated)
  --dry-run                  Print tool definitions as JSON without generating
```

## Auth modes

Auth is auto-detected from the spec's `securitySchemes` when `--auth` is not set.

| Mode | Env vars | Description |
|------|----------|-------------|
| `none` | - | No authentication |
| `api-key` | `API_KEY` | API key sent in the header defined in spec (e.g. `X-API-Key`) |
| `bearer` | `API_TOKEN` | Bearer token in `Authorization` header |
| `oauth2` | `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_TOKEN_URL` | OAuth2 client credentials with token caching |

## Vendor extensions

Control how operations are mapped to MCP tools using OpenAPI vendor extensions:

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

## Example: Petstore API

Input (`petstore.yaml`):

```yaml
openapi: "3.0.3"
info:
  title: Petstore
  version: "1.0.0"
paths:
  /pets:
    get:
      operationId: listPets
      summary: List all pets
      parameters:
        - name: limit
          in: query
          schema:
            type: integer
    post:
      operationId: createPet
      summary: Create a pet
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name]
              properties:
                name:
                  type: string
                tag:
                  type: string
```

Generated tools:

```typescript
server.tool("listPets", "List all pets", {
  limit: z.number().optional(),
}, async ({ params }) => {
  // GET /pets?limit=...
});

server.tool("createPet", "Create a pet", {
  name: z.string(),
  tag: z.string().optional(),
}, async ({ params }) => {
  // POST /pets with JSON body
});
```

## How it works

1. **Parser** loads the spec (file or URL), validates OpenAPI 3.x, resolves all `$ref` inline. Inline resolution is required because some MCP clients (Claude Code, Amazon Bedrock) don't handle `$ref` in tool schemas.

2. **Mapper** converts each operation to an MCP tool definition. Parameters (path, query) and request body properties are flattened into a single input schema. Auth requirements are extracted from security schemes.

3. **Generator** renders a TypeScript file with MCP SDK imports, Zod schemas, auth helpers, and a transport setup. Outputs a complete project with `package.json` and `tsconfig.json`.

## Programmatic API

```typescript
import { parseSpec, mapToMcpTools, generate } from "openapi-to-mcp";

const spec = await parseSpec("./api-spec.yaml");
const tools = mapToMcpTools(spec, {
  includeTags: ["public"],
  excludeOperations: ["deprecated_endpoint"],
});

await generate({
  tools,
  spec,
  outputDir: "./output",
  serverName: "My API",
  transport: "stdio",
  auth: "bearer",
});
```

## Roadmap

- [ ] OAuth2 Authorization Code + PKCE
- [ ] Cursor-based pagination wrapper
- [ ] Streamable HTTP transport
- [ ] Workflow grouping (merge related endpoints into composite tools)
- [ ] Multi-client schema adaptation (Claude vs Bedrock vs GPT)
- [ ] MCP 2026-07-28 spec support (stateless)
- [ ] Pre-built presets for popular APIs (Stripe, GitHub, Notion)
- [ ] npm publish

## Contributing

PRs welcome. Please open an issue first to discuss non-trivial changes.

## License

MIT
