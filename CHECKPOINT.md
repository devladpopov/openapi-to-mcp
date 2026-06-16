STATUS: COMPLETED
TASK: Full improvement plan: schema quality, e2e, CI, real-spec hardening
DATE: 2026-06-12
LAST_ACTION: PUBLISHED to npm as openapi-mcp-codegen@0.2.0 (HEAD c9bafdc, tag v0.2.0). 74 tests pass, CI green ubuntu+windows. npm name "openapi-to-mcp" was taken (Rustho), so package + CLI bin renamed to openapi-mcp-codegen. Repo public.
NEXT: await user input. Optional remaining: promo posts from drafts/ (REQUIRE separate explicit confirmation per safety rules), v0.3 features (multi-client schema adaptation, webhooks via Tasks from RESEARCH.md).
DO_NOT_REDO:
- Market research (RESEARCH.md), MVP, v0.2 (OAuth2 flows, pagination, streaming, dual build)
- Runtime bug fixes: async (params), handleRequest(req,res), body/path param separation
- Schema quality refactor: refs.ts rewrite, param locations, collisions, response hints, zod enums/unions/nested/nullable (commit f5caffa)
- refs.ts memoization fix for exponential inlining, Stripe OOM 21GB -> 0.4s (commit 557c095)
- Form-encoded body support: x-www-form-urlencoded fallback, formEncode bracket notation (commit 557c095)
- In-repo e2e test: generate + bun install + tsc in tmp dir (commit 70cad74)
- GitHub Actions CI ubuntu+windows, smoke test fixed -i flag (commit c50dae9), run green
- git push done, repo already public
- npm publish done: openapi-mcp-codegen@0.2.0 live, verified in registry (commit c9bafdc, tag v0.2.0)
- DO NOT republish 0.2.0 (immutable on npm); next release must bump version
VERIFY_BEFORE_ACT:
- git log --oneline -3
- bun test
- curl -s "https://api.github.com/repos/devladpopov/openapi-to-mcp/actions/runs?per_page=1"
- npm package name availability: curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/<name>
