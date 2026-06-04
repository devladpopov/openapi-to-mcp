# Генератор MCP-серверов из OpenAPI: зачем, как и что дальше

## Проблема

У вас есть REST API с OpenAPI-спецификацией. Вы хотите, чтобы Claude, ChatGPT или Cursor могли с ним работать напрямую. Для этого нужен MCP-сервер (Model Context Protocol), стандарт от Anthropic, который уже поддерживают Claude, VS Code, Cursor, Gemini CLI, и даже ChatGPT.

Писать MCP-сервер руками скучно. Каждый endpoint превращается в tool с описанием, схемой параметров, обработкой auth и сериализацией. Для API на 50 endpoints это несколько дней рутины.

Логичный вопрос: почему бы не сгенерировать MCP-сервер автоматически из OpenAPI-спеки?

## Что уже есть на рынке

Я исследовал 35+ проектов на GitHub. Вот ключевые:

```
Проект                         Lang    Stars  Auth              Pagination
harsha-iiiv/openapi-mcp-gen    TS      595    OAuth2 CC, keys   нет
janwilmake/openapi-mcp-server  TS      894    нет               нет
awslabs/mcp                    Python  9200*  env vars          нет
brizzai/auto-mcp               Go      191    OAuth 2.1 PKCE    нет
Speakeasy                      Go/JS   415    полный            да ($720/mo)
```

Ни один open-source инструмент не поддерживает одновременно: все OAuth2 flows, pagination, webhooks, умный маппинг операций. Коммерческие решения (Speakeasy, Stainless) стоят от $250 до $720 в месяц.

## Что мы сделали

`openapi-to-mcp` -- TypeScript CLI, который генерирует готовый MCP-сервер из OpenAPI 3.x спецификации.

```bash
npx openapi-to-mcp generate -i petstore.yaml -o ./my-mcp-server
cd my-mcp-server && npm install && npm start
```

На выходе: полный TypeScript-проект с MCP SDK, Zod-валидацией, поддержкой auth (API key, Bearer, OAuth2 client credentials) и stdio-транспортом.

### Как устроено внутри

Три этапа:

**1. Парсер.** Загружает YAML/JSON (файл или URL), валидирует OpenAPI 3.x, инлайнит все `$ref`. Последнее критично: Claude Code и Amazon Bedrock не понимают `$ref` в JSON Schema, и без инлайна tools просто не работают.

**2. Маппер.** Каждая операция (operationId) становится MCP tool. Параметры (path, query) и request body превращаются в Zod-схему. Поддерживаются vendor extensions `x-mcp-exclude`, `x-mcp-name`, `x-mcp-description` для тонкой настройки.

**3. Генератор.** Собирает TypeScript-файл с импортами MCP SDK, определениями tools, auth-хелпером и transport setup. Рядом кладет `package.json`, `tsconfig.json`, `.env.example`.

### Пример сгенерированного tool

Из Petstore OpenAPI:

```typescript
server.tool(
  "createPet",
  "Create a pet",
  {
    name: z.string().describe("Name of the pet"),
    tag: z.string().optional().describe("Optional tag"),
  },
  async ({ params }) => {
    const url = `${API_BASE_URL}/pets`;
    const headers = { ...authHeaders(), "Content-Type": "application/json" };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(params),
    });
    const data = await res.text();
    return {
      content: [{ type: "text" as const, text: data }],
    };
  },
);
```

## Технические проблемы, которые пришлось решать

### $ref и anyOf: зоопарк клиентов

Разные AI-платформы по-разному обрабатывают JSON Schema:

```
Платформа          $ref    anyOf   oneOf   allOf
Claude Desktop     да      да      да      да
Claude Code        да      нет     нет     да
Amazon Bedrock     нет     нет     нет     нет
Azure AI Foundry   да      нет     нет     да
```

Мы инлайним все `$ref` при парсинге. В планах: multi-client schema adaptation, где генератор будет выдавать упрощенные схемы для платформ с ограничениями.

### Слишком много tools

GitHub API: 600+ endpoints. Если каждый станет tool, LLM запутается и начнет вызывать не те. Neon написали целый пост о том, что 1:1 маппинг -- антипаттерн.

Решение: фильтрация через `x-mcp-exclude` и tag-based include/exclude. В планах: workflow-level grouping, где несколько endpoints объединяются в один логический tool.

### Auth: не только API key

Большинство конкурентов поддерживают только статические ключи или OAuth2 Client Credentials. Реальные API используют Authorization Code + PKCE, refresh tokens, API keys в разных местах (header, query, cookie).

MCP spec с ноября 2025 требует OAuth 2.1 с PKCE для публичных серверов. Это большой кусок работы, который мы планируем в v0.2.

## Экосистема MCP в цифрах (июнь 2026)

- 97M загрузок SDK в месяц (рост 970x за 18 месяцев)
- 10,000-20,000+ серверов в реестрах
- MCP передан из Anthropic в Linux Foundation (Agentic AI Foundation)
- Поддержка: Claude, Cursor, VS Code, ChatGPT, Gemini CLI, Windsurf, Zed
- Следующая версия spec (2026-07-28): stateless протокол, MCP Apps

## Что дальше

**v0.2** (ближайшие недели):
- OAuth2 Authorization Code + PKCE
- Cursor-based pagination wrapper (трансляция из offset/page)
- Streamable HTTP transport

**v0.3:**
- Workflow grouping (`x-mcp-workflow`)
- Multi-client schema adaptation
- Pre-built presets для популярных API (Stripe, GitHub, Notion)

**v1.0:**
- MCP 2026-07-28 spec (stateless)
- Публикация в npm
- Submission во все реестры (mcp.so, Smithery, Glama, Official)

## Ссылки

- GitHub: https://github.com/devladpopov/openapi-to-mcp
- MCP Spec: https://modelcontextprotocol.io
- MCP SDK (TypeScript): https://github.com/modelcontextprotocol/typescript-sdk

Если у вас есть OpenAPI-спека и вы хотите попробовать: клонируйте репо, `bun install && bun run build`, и запустите `bun dist/cli.js generate -i your-spec.yaml -o ./output`. Фидбек и PR приветствуются.
