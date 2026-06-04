# r/ChatGPTCoding

**Title:** Open-source tool to generate MCP servers from any OpenAPI spec

**Body:**

MCP (Model Context Protocol) is now supported by Claude, ChatGPT (dev mode), Cursor, VS Code, and Gemini CLI. It lets AI assistants call external APIs as "tools."

Problem: creating an MCP server for your API means writing a lot of boilerplate. Each endpoint needs a tool definition, parameter schema, auth handling, response formatting.

I built a CLI that automates this. Give it an OpenAPI 3.x spec, get a TypeScript MCP server:

```bash
npx openapi-to-mcp generate -i your-api.yaml -o ./mcp-server
```

Output is a standalone TypeScript project. `npm install && npm start` and you have a working MCP server.

Works with any API that has an OpenAPI/Swagger spec. Auth modes: API key, Bearer token, OAuth2. Tested with Petstore, planning to add presets for popular APIs (Stripe, GitHub, Notion).

Free, MIT: https://github.com/devladpopov/openapi-to-mcp

Feedback appreciated, especially if you try it with a real API.
