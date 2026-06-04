# r/typescript

**Title:** openapi-to-mcp: Generate MCP servers from OpenAPI specs (TypeScript CLI)

**Body:**

Built a TypeScript CLI that converts OpenAPI 3.x specifications into ready-to-run MCP (Model Context Protocol) servers.

MCP is the protocol that Claude, Cursor, VS Code Copilot, and other AI tools use to interact with external APIs. Instead of writing MCP servers by hand for each API, this tool generates them.

**How it works:**
1. Parser loads YAML/JSON spec, validates OpenAPI 3.x, resolves all `$ref` inline
2. Mapper converts each `operationId` to an MCP tool with Zod input schema
3. Generator outputs a TypeScript project (server.ts, package.json, tsconfig.json)

```bash
bun dist/cli.js generate -i spec.yaml -o ./mcp-server --auth bearer
```

**Stack:** TypeScript, MCP SDK, Zod, Commander, YAML parser. No runtime deps beyond MCP SDK in generated output.

**Interesting technical decisions:**
- All `$ref` resolved at parse time because some MCP clients (Claude Code, Bedrock) don't handle them
- Zod schemas generated from JSON Schema for runtime validation
- Request body properties flattened into tool params (better LLM UX vs nested `body` object)
- `x-mcp-exclude` / `x-mcp-name` vendor extensions for controlling output

GitHub: https://github.com/devladpopov/openapi-to-mcp

Early stage, feedback welcome. Planning to add OAuth2 PKCE, pagination cursors, and Streamable HTTP next.
