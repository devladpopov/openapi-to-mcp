STATUS: COMPLETED
TASK: v0.2 features, npm publish prep, dual build
DATE: 2026-06-05
LAST_ACTION: Added OAuth2 auth-code+PKCE, pagination, streaming, Streamable HTTP transport, 48 tests, dual ESM/CJS build via tsup
NEXT: await user input (npm publish, make repo public, or continue v0.3 features)
DO_NOT_REDO:
- Market research (RESEARCH.md, 35+ competitors analyzed)
- MVP implementation (parser, mapper, generator, CLI)
- Auth auto-detect from securitySchemes
- OAuth2 Authorization Code + PKCE flow (local callback server, token refresh)
- OAuth2 Client Credentials flow
- Pagination (offset, page, cursor auto-detection, x-mcp-pagination hints)
- Streaming response handling (SSE, NDJSON)
- Streamable HTTP transport
- 48 tests across 7 test files, all passing
- README.md fully updated with all v0.2 features
- package.json v0.2.0 prepared for npm (keywords, homepage, bugs, author)
- Dual build: ESM (index.js) + CJS (index.cjs) + types (index.d.ts, index.d.cts) via tsup
- LICENSE (MIT)
- Promotion drafts (7 files in drafts/)
- Git push to github.com/devladpopov/openapi-to-mcp
VERIFY_BEFORE_ACT:
- git log --oneline -5
- bun test
- bun run build
