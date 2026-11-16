# Relocation Concierge — навчальна агентна платформа

Практичний кейс до співбесіди на Agent Platform Engineer: агент допомагає новим працівникам знайти
оренду у Львові. Навколо нього — LLM gateway, MCP-сервери, SSO, аудит, evals, Temporal,
software factory і мінімальний no-code builder.

## Швидкий старт

```bash
corepack enable
pnpm install
pnpm typecheck && pnpm test
cp .env.example .env && pnpm gateway   # LLM gateway на :8787
```

## Документи

- [docs/case.md](docs/case.md) — специфікація кейсу
- [docs/interview-answers.md](docs/interview-answers.md) — відповіді до співбесіди
- [CLAUDE.md](CLAUDE.md) — контекст для Claude Code

## Етапи

| Етап | Що | Пояснення |
| --- | --- | --- |
| 0 | Монорепо, спільні схеми, фікстури | [docs/stages/00-foundation.md](docs/stages/00-foundation.md) |
| 1 | LLM gateway | [docs/stages/01-gateway.md](docs/stages/01-gateway.md) |
| 2 | MCP-сервери listings і relocation | — |
| 3 | Цикл агента + CLI-чат | — |
| 4 | SSO, делегування, authz, аудит | — |
| 5 | Evals + гейт у CI | — |
| 6 | Temporal | — |
| 7 | Software factory | — |
| 8 | No-code builder | — |
| 9 | Інциденти, ADR, README «що далі» | — |
