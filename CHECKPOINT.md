STATUS: COMPLETED
TASK: Full improvement plan: schema quality, e2e, CI, real-spec hardening
DATE: 2026-06-12
LAST_ACTION: All engineering done and pushed (HEAD c50dae9). 74 tests pass. CI green on ubuntu + windows. Real specs verified: Stripe (587 tools) and GitHub (1190 tools) generate and pass tsc.
NEXT: npm publish BLOCKED on package name: "openapi-to-mcp" is TAKEN on npm (Rustho, v0.1.5). Free alternatives: oas-to-mcp, spec-to-mcp, scoped @devladpopov/openapi-to-mcp. Awaiting Vlad's choice. Repo is already PUBLIC.
DO_NOT_REDO:
- Market research (RESEARCH.md), MVP, v0.2 (OAuth2 flows, pagination, streaming, dual build)
- Runtime bug fixes: async (params), handleRequest(req,res), body/path param separation
- Schema quality refactor: refs.ts rewrite, param locations, collisions, response hints, zod enums/unions/nested/nullable (commit f5caffa)
- refs.ts memoization fix for exponential inlining, Stripe OOM 21GB -> 0.4s (commit 557c095)
- Form-encoded body support: x-www-form-urlencoded fallback, formEncode bracket notation (commit 557c095)
- In-repo e2e test: generate + bun install + tsc in tmp dir (commit 70cad74)
- GitHub Actions CI ubuntu+windows, smoke test fixed -i flag (commit c50dae9), run green
- git push done, repo already public
VERIFY_BEFORE_ACT:
- git log --oneline -3
- bun test
- curl -s "https://api.github.com/repos/devladpopov/openapi-to-mcp/actions/runs?per_page=1"
- npm package name availability: curl -s -o /dev/null -w "%{http_code}" https://registry.npmjs.org/<name>
