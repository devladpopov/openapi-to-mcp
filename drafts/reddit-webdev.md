# r/webdev

**Title:** Automate MCP server creation from your OpenAPI specs (open-source TypeScript CLI)

**Body:**

If you have a REST API with an OpenAPI spec and want AI tools (Claude, Cursor, VS Code Copilot) to interact with it, you need an MCP server. Writing one manually means mapping every endpoint to a tool definition, handling auth, serializing params. For a 50-endpoint API, that's days of boilerplate.

I built `openapi-to-mcp`: point it at your OpenAPI 3.x spec, get a working TypeScript MCP server.

```bash
npx openapi-to-mcp generate -i api-spec.yaml -o ./mcp-server --auth api-key
cd mcp-server && npm install && npm start
```

Generated server includes:
- MCP tool for each API operation
- Zod validation for all parameters
- Auth handling (API key, Bearer, OAuth2 CC)
- Path param interpolation, query string building
- stdio transport (works with Claude Desktop config)

After researching 35+ existing tools, the gap was clear: no open-source TypeScript generator handles auth properly, none support pagination, and commercial options start at $250/mo.

MIT: https://github.com/devladpopov/openapi-to-mcp
