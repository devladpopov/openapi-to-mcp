STATUS: COMPLETED
TASK: Research + MVP + promotion drafts
DATE: 2026-06-04
LAST_ACTION: Created promotion drafts in drafts/ for Habr, Reddit (4 subs), HN, dev.to
NEXT: await user input (review drafts, decide publish order, or continue dev work)
DO_NOT_REDO:
- Market research (RESEARCH.md, 35+ competitors analyzed)
- MVP implementation (parser, mapper, generator, CLI)
- Build and test (Petstore fixture passes)
- Git push to github.com/devladpopov/openapi-to-mcp
- Promotion drafts (7 files in drafts/)
VERIFY_BEFORE_ACT:
- git log --oneline -5
- ls drafts/
- bun run build
