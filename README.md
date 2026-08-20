# LinkedAPI

Camada proxy sobre a Unipile para automacao de LinkedIn. O cliente usa "a nossa
API" em BRL; por baixo roteamos para a Unipile sob uma unica conta-mestra.

Documento-mae: [PRD.md](PRD.md). Contexto para IA: [CLAUDE.md](CLAUDE.md).
Onde estamos e o que falta: [HANDOFF.md](HANDOFF.md) e
[docs/pendencias.md](docs/pendencias.md). Roteiro de ativacao:
[docs/go-live.md](docs/go-live.md).

> **O que precisa de MAO HUMANA para avancar: [ACOES-HUMANAS.md](ACOES-HUMANAS.md).**
> Todo o resto ja e codigo pronto ou comando.

## Setup rapido

```bash
npm install
cp .dev.vars.example .dev.vars   # preencha com credenciais reais (nao versionar)
npm run dev                      # Worker local em http://localhost:8787
npm run typecheck && npm test    # 100 testes
```

## Estrutura

| Caminho | O que e |
|---|---|
| `PRD.md` | Documento-mae: porque, o que e decisoes tecnicas |
| `CLAUDE.md` | Contexto sempre-carregado para o Claude Code |
| `HANDOFF.md` | Onde estamos e o que falta (snapshot) |
| `docs/` | Arquitetura, decisoes, pendencias, go-live, notas da Unipile |
| `specs/` | Uma spec por marco da V1 + fase 2 |
| `src/` | Worker (Hono): proxy, auto-conexao, hooks de evento, self-service, admin |
| `scripts/` | Operador: chaves, tenants, conexao, billing, webhooks, deploy, prova |
| `supabase/migrations/` | Schema + RLS (0001-0007; `bootstrap.sql` = tudo em um) |
| `test/` | 100 testes (destaque: isolamento multi-tenant) |
| `.claude/` | Agents, skills e hooks do projeto |

## As tres regras que nao se reabrem

1. `account_id` sempre resolvido no servidor, nunca vindo do request.
2. Master token e DSN da Unipile nunca saem do servidor.
3. Da API key guardamos so o hash.

Detalhes e o restante em [CLAUDE.md](CLAUDE.md) e [PRD.md](PRD.md).
