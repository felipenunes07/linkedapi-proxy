# LinkedAPI (codinome a definir)

Camada proxy sobre a Unipile para automacao de LinkedIn. O cliente usa "a nossa
API" em BRL; por baixo roteamos para a Unipile sob uma unica conta-mestra.

Documento-mae: [PRD.md](PRD.md). Contexto para IA: [CLAUDE.md](CLAUDE.md).

## Setup rapido

```bash
npm install
cp .dev.vars.example .dev.vars   # preencha com credenciais reais (nao versionar)
npm run dev                      # Worker local em http://localhost:8787
```

## Estrutura

| Caminho | O que e |
|---|---|
| `PRD.md` | Documento-mae: porque, o que e decisoes tecnicas |
| `CLAUDE.md` | Contexto sempre-carregado para o Claude Code |
| `docs/` | Arquitetura, decisoes e notas da Unipile (contexto sob demanda) |
| `specs/` | Uma spec auto-contida por marco da V1 |
| `src/` | Codigo do Worker (Hono): pipeline do proxy |
| `supabase/migrations/` | Schema + RLS (rascunho, revisar no Marco 2) |
| `test/` | Testes (destaque: isolamento multi-tenant) |
| `.claude/` | Agents, skills e hooks do projeto |

## As tres regras que nao se reabrem

1. `account_id` sempre resolvido no servidor, nunca vindo do request.
2. Master token e DSN da Unipile nunca saem do servidor.
3. Da API key guardamos so o hash.

Detalhes e o restante em [CLAUDE.md](CLAUDE.md) e [PRD.md](PRD.md).
