---
title: "How to Generate an MCP Server from Your OpenAPI Spec in 30 Seconds"
published: false
tags: typescript, ai, mcp, openapi
---

## The Problem

You have a REST API. You want Claude, Cursor, or VS Code Copilot to use it. You need an MCP server.

MCP (Model Context Protocol) is the standard protocol for connecting AI models to external tools. It's supported by Claude, ChatGPT, Cursor, VS Code, Gemini CLI, and Windsurf. The ecosystem has grown to 97M SDK downloads/month and 20,000+ servers.

Writing an MCP server by hand means:
- Defining a tool for each API endpoint
- Writing JSON Schema for every parameter
- Handling auth (API keys, Bearer tokens, OAuth2)
- Building request URLs with path interpolation and query strings
- Parsing responses

For a 50-endpoint API, this is days of boilerplate.

## The Solution

`openapi-to-mcp` generates it all from your OpenAPI spec:

```bash
npx openapi-to-mcp generate -i petstore.yaml -o ./mcp-server
cd mcp-server && npm install && npm start
```

Done. Your API is now accessible to any MCP-compatible AI tool.

## What Gets Generated

A complete TypeScript project:

```
mcp-server/
  src/server.ts      # MCP server with all tools
  package.json       # Dependencies (MCP SDK, Zod)
  tsconfig.json      # TypeScript config
  .env.example       # Auth configuration template
```

Each API operation becomes an MCP tool:

```typescript
server.tool(
  "listPets",
  "List all pets",
  {
    limit: z.number().optional()
      .describe("Maximum number of pets to return"),
  },
  async ({ params }) => {
    const url = `${API_BASE_URL}/pets?limit=${params.limit}`;
    const res = await fetch(url, { headers: authHeaders() });
    const data = await res.text();
    return {
      content: [{ type: "text", text: data }],
    };
  },
);
```

## Features

**Auth modes:** none, API key, Bearer token, OAuth2 (client credentials). Set via `--auth` flag.

**$ref resolution:** All `$ref` pointers inlined at parse time. This matters because Claude Code and Amazon Bedrock don't handle `$ref` in tool schemas.

**Vendor extensions:** Control which operations become tools:
```yaml
paths:
  /internal/health:
    get:
      x-mcp-exclude: true  # Skip this endpoint
  /users:
    get:
      x-mcp-name: search_users  # Custom tool name
      x-mcp-description: "Search users by name or email"
```

**Tag filtering:** Include or exclude endpoints by OpenAPI tags.

**Dry run:** Preview tool definitions without generating files:
```bash
npx openapi-to-mcp generate -i spec.yaml --dry-run
```

## Why Not Use Existing Tools?

I analyzed 35+ projects in this space:

- **openapi-mcp-generator** (595 stars): closest competitor, but no pagination, no webhooks, OAuth2 limited to client credentials
- **openapi-mcp-server** (894 stars): read-only spec explorer, not a generator
- **Speakeasy** ($720/mo): full platform, but commercial
- **Stainless** ($250/mo): SDK-focused, MCP as addon

No open-source TypeScript tool handles the full picture: all auth flows, pagination, schema adaptation for different AI clients.

## Roadmap

**v0.2:** OAuth2 Authorization Code + PKCE, cursor-based pagination wrapper, Streamable HTTP transport

**v0.3:** Workflow-level grouping (merge related endpoints into single tools), multi-client schema adaptation

**v1.0:** MCP 2026-07-28 spec support (stateless), npm publish, registry submissions

## Try It

```bash
git clone https://github.com/devladpopov/openapi-to-mcp
cd openapi-to-mcp
bun install && bun run build
bun dist/cli.js generate -i tests/fixtures/petstore.yaml -o ./output
```

MIT licensed. Feedback and PRs welcome.

GitHub: https://github.com/devladpopov/openapi-to-mcp
