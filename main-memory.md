---
tags: [hub, long-term-memory]
updated: 2026-04-05
---
# MEMORY.md - Long-Term Memory (Index)

## Влад
- Разработчик, общение на русском, на "вы"
- Ценит прямоту и профессиональную обратную связь
- "StudyQA Алина" / "Алина Studyqa" = чат -291543573 (НЕ StudyQA team!)
- Любые траты — спрашивать подтверждение
- GitHub: https://github.com/devladpopov
- Подробности: [[people/team-studyqa]]

## Проекты (индекс)
| Проект | Статус | Детали |
|--------|--------|--------|
| ixParcel | Активный | [[projects/ixparcel]] |
| Stadika | Активный | [[projects/stadika]] |
| MaxPost | Активный | maxpost.vladislavpopov.ru, Hetzner 178.104.49.217:3102 |
| @popovvii канал | Пауза | [[projects/popovvii-channel]] |
| AiMagicHub | Поддержка | [[topics/topic-667]] |
| vladislavpopov.ru | Поддержка | Beget |
| MOTReady | Новый | [[projects/motready]] |
| Инфраструктура | Всегда | memory/services/ |

## Model Orchestration
- **Основная модель**: Gemini 3 Flash Preview (для всего).
- **Сложные задачи**: Gemini 2.5 Pro.
- **Внешние инструменты**: Opus 4.6 используется Владом только через Claude Code / Terminal.
- Подробно: AGENTS.md → "Model Orchestration"

## Knowledge Directory — где искать ответы
| Тема | Где искать |
|------|-----------|
| SSH, серверы, Docker | memory/services/servers.md |
| Домены, DNS, SSL | memory/services/domains.md |
| API-ключи, токены | memory/services/api-keys.md + TOOLS.md |
| CF Browser Rendering | TOOLS.md → "Cloudflare Browser Rendering" |
| Email, IMAP, OAuth | memory/services/email.md |
| Бэкапы, Restic | memory/services/backups.md |
| SSH, серверы, Docker | memory/services/servers.md |
| Домены, DNS, SSL | memory/services/domains.md |
| API-ключи, токены | memory/services/api-keys.md + TOOLS.md |
| CF Browser Rendering | TOOLS.md → "Cloudflare Browser Rendering" |
| Email, IMAP, OAuth | memory/services/email.md |
| Бэкапы, Restic | memory/services/backups.md |
| ixParcel Paperless | memory/topics/topic-17578.md |
| Мониторинг Grafana | memory/topics/topic-23921.md |
| Люди и контакты | memory/people/ |
| TOV (стиль текстов) | memory/shared/tov-vladislav-popov.md |
| Контент @popovvii | memory/shared/popovvii-content-guide.md |
| Текущие задачи | TODO.md |
| Topic Directory | memory/shared/topic-directory.md |
| Критические уроки | memory/shared/critical-lessons.md |
| Правила деплоя | AGENTS.md → "Правила деплоя и Git" |
| Cron best practices | memory/shared/cron-best-practices.md |

## Люди
- **Никита Траторов** — разработчик ixParcel. [[people/team-studyqa]]
- **Алина Соколова** (@Sokolovaali, ID:315377805) — контент-стратег @popovvii
- **Алексей Вальков** — директор ПМЭФ. [[people/valkov-aleksey]]

## Самоизменение роутера: правило (2026-04-16)
Бот НЕ ДОЛЖЕН редактировать файлы роутера (`claude-topic-router/`),
убивать процессы, перезапускать bun/runner, или менять settings.json.
Причина: бот работает внутри bun — убив его, он убивает себя.

**Но бот ДОЛЖЕН помочь с решением:**
- Прочитать файлы, проанализировать проблему
- Предложить конкретный fix (diff, патч, описание изменений)
- Написать готовый контекст для Claude Cowork (десктопное приложение)
- Формат: задача + файл + что менять + команда рестарта
- Влад копирует контекст в Cowork, там Claude применяет изменение
