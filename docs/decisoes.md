# Decisoes tecnicas (log)

Registro curto das decisoes ja tomadas e do porque, para ninguem reabrir sem
motivo. Detalhe completo em @PRD.md secao 3 e 5.

| # | Decisao | Porque | Status |
|---|---|---|---|
| D1 | `account_id` resolvido server-side, nunca do request | Sem isso, cliente A age como B. Regra de seguranca #1. | Firme |
| D2 | Master token e DSN so no servidor, nunca em cliente/log | Vazamento compromete o negocio inteiro. | Firme |
| D3 | Guardar so o hash da API key | Reduz dano de vazamento do banco. | Firme |
| D4 | Rate limiting ja na V1 | Enviar msg/convite restringe contas no LinkedIn. | Firme |
| D5 | Uma unica conta-mestra Unipile, sem sharding | Custo por slot e plano; risco de suspensao age no dono da conta. | Firme (nao acoplar de forma que impeca segmentar depois) |
| D6 | Escopo so LinkedIn, so 3 endpoints na V1 | Provar o nucleo, nao espelhar 500+ endpoints. | Firme |
| D7 | Sem Recruiter/Jobs/Ads | Recruiter e origem de problemas de sessao/reconexao. | Firme |
| D8 | Sem n8n em nenhum caminho | Nao serve para API publica sincrona; falha sob rajada. | Firme |
| D9 | Cloudflare Workers + Hono para o proxy | Sincrono, baixa latencia, global, barato. | Firme (Vercel Functions e alternativa aceitavel) |
| D10 | Supabase (Postgres + RLS) | Isolamento de tenant no banco. | Firme |

## Em aberto (ver PRD secao 12)
- Nome/marca do produto e dominio da API.
- Valores default do rate limiter (partir dos recomendados pela Unipile).
- Provedor de rate limit: Cloudflare KV vs Upstash Redis (decidir no Marco 3).
