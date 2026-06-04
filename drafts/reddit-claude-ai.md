# r/ClaudeAI

**Title:** I built a CLI that generates MCP servers from any OpenAPI spec (TypeScript, open-source)

**Body:**

I got tired of hand-writing MCP servers for every REST API I wanted Claude to access. So I built a generator.

**What it does:** Takes an OpenAPI 3.x spec (YAML/JSON), outputs a ready-to-run TypeScript MCP server with stdio transport.

```bash
npx openapi-to-mcp generate -i petstore.yaml -o ./server
cd server && npm install && npm start
```

**Features:**
- Parses OpenAPI 3.x, resolves all $ref inline (important: Claude Code doesn't handle $ref in tool schemas)
- Maps each operation to an MCP tool with Zod validation
- Auth: API key, Bearer, OAuth2 client credentials
- Vendor extensions: `x-mcp-exclude`, `x-mcp-name` for fine-tuning
- `--dry-run` to preview tool definitions as JSON

**Why not use existing tools?** I analyzed 35+ projects on GitHub. The closest TypeScript competitor (`openapi-mcp-generator`, 595 stars) doesn't support pagination, webhooks, or multi-client schema adaptation. Commercial options (Speakeasy, Stainless) start at $250-720/mo.

**Coming next:**
- OAuth2 Authorization Code + PKCE
- Cursor-based pagination wrapper
- Streamable HTTP transport
- MCP 2026-07-28 spec (stateless)

MIT licensed: https://github.com/devladpopov/openapi-to-mcp

Would love feedback, especially from people who've tried connecting REST APIs to Claude.
