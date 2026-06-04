# OpenAPI to MCP Generator

Память проекта. Создан из Telegram-топика.

## Контекст создания
Дата: 2026-06-03
Группа: -1003894282745
Топик: 65084

## Исследование рынка (2026-06-03)

### Ключевые факты
- MCP SDK: 97M загрузок/месяц (март 2026), 970x рост за 18 месяцев
- 10,000-20,000+ MCP серверов в реестрах
- MCP spec: текущая 2025-11-25, следующая 2026-07-28 RC (stateless, MCP Apps)
- MCP передан в Agentic AI Foundation (Linux Foundation)
- Поддержка: Claude, Cursor, VS Code, ChatGPT (частично), Gemini CLI, Windsurf

### Прямые конкуренты (TypeScript)
- harsha-iiiv/openapi-mcp-generator: 595 stars, CLI codegen, MIT. OAuth2 CC, API keys, Bearer. НЕТ pagination, webhooks.
- janwilmake/openapi-mcp-server: 894 stars, read-only exploration, не генератор
- FrontMCP: 144 stars, framework с OpenAPI adapter
- ivo-toby/mcp-openapi-server: 265 stars, runtime server

### Коммерческие конкуренты
- Speakeasy: $720/mo, полная платформа SDK+MCP
- Stainless: $250-800/mo per SDK
- DigitalAPI: no-code SaaS

### Наши потенциальные преимущества
1. Полный auth (OAuth2 все flows, не только CC)
2. Pagination (cursor-based трансляция из offset/page)
3. Webhooks через Tasks primitive (первый на рынке)
4. Умный workflow-level маппинг (не тупой 1:1)
5. Multi-client schema adaptation (anyOf handling для разных платформ)
6. MCP 2026-07-28 ready (stateless)

### Монетизация
Рекомендация: open-source CLI (npm) + paid SaaS (hosted generation, auth management, monitoring)

### Полное исследование
Файл: RESEARCH.md
