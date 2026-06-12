STATUS: COMPLETED
TASK: v0.2 + critical bug fixes after full e2e audit
DATE: 2026-06-12
LAST_ACTION: Fixed 3 runtime bugs in generated code (handler { params } destructuring, handleRequest signature, body included path params), verified live with stdio smoke test, 52 tests, pushed 605640d
NEXT: await user input (npm publish, make repo public, or v0.3 features)
DO_NOT_REDO:
- Market research (RESEARCH.md, 35+ competitors analyzed)
- MVP implementation (parser, mapper, generator, CLI)
- Auth auto-detect from securitySchemes
- OAuth2 Authorization Code + PKCE flow (local callback server, token refresh)
- OAuth2 Client Credentials flow
- Pagination (offset, page, cursor auto-detection, x-mcp-pagination hints)
- Streaming response handling (SSE, NDJSON)
- Streamable HTTP transport (handleRequest(req, res) fixed)
- Handler bug fix: async (params), not async ({ params })
- E2E verified: all 5 generated server variants typecheck; petstore server passes initialize/tools-list/tools-call against mock API
- 52 tests across 7 test files, all passing
- README.md fully updated with all v0.2 features
- package.json v0.2.0 prepared for npm (keywords, homepage, bugs, author)
- Dual build: ESM (index.js) + CJS (index.cjs) + types (index.d.ts, index.d.cts) via tsup
- LICENSE (MIT)
- Promotion drafts (7 files in drafts/)
- Git push to github.com/devladpopov/openapi-to-mcp (5 commits, HEAD 605640d)
VERIFY_BEFORE_ACT:
- git log --oneline -5
- bun test
- bun run build
