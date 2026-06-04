# Hacker News

**Title:** Show HN: Generate MCP servers from OpenAPI specs (TypeScript)

**URL:** https://github.com/devladpopov/openapi-to-mcp

**Comment (if text post):**

openapi-to-mcp is a TypeScript CLI that takes an OpenAPI 3.x spec and generates a ready-to-run MCP (Model Context Protocol) server.

MCP is the protocol Claude, Cursor, VS Code, and ChatGPT use to let AI models call external tools. If you have a REST API, an MCP server makes it accessible to these AI assistants.

Usage:
```
npx openapi-to-mcp generate -i spec.yaml -o ./server --auth bearer
```

Generated output is a TypeScript project using the official MCP SDK with Zod validation. Supports API key, Bearer, and OAuth2 (client credentials) auth.

I researched 35+ existing tools in this space. The closest open-source TypeScript competitor has 595 stars but lacks pagination, webhooks, and proper multi-auth support. Commercial solutions (Speakeasy, Stainless) start at $250/mo.

Technical notes:
- All $ref pointers resolved inline at parse time (Claude Code and Bedrock don't handle $ref in tool schemas)
- Request body properties flattened into tool params for better LLM ergonomics
- x-mcp-exclude/x-mcp-name vendor extensions for controlling which operations become tools
- Tag-based filtering for large APIs

Next: OAuth2 PKCE, cursor-based pagination, Streamable HTTP transport, MCP 2026-07-28 spec support.

MIT licensed.
