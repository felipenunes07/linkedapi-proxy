# Arquitetura

Resumo carregado sob demanda. A fonte completa e @PRD.md (secoes 5 e 6);
fase 2 detalhada em @specs/fase-2.md.

## Dois planos

- **Control plane**: cadastro, emissao de chave, billing, admin. Tolerante a
  latencia. Na pratica: scripts do operador (`scripts/`), rotas self-service
  (`/v1/keys/rotate`, `/v1/webhook`), hooks de evento (`/hooks/*`) e a API
  admin (`/admin/*`).
- **Data plane**: o proxy que roteia a chamada do cliente para a Unipile em
  tempo real. Rapido e sempre no ar. E o coracao da V1.

## Fluxo do proxy (data plane)

```
App do cliente
   |  POST api.minhamarca.com/v1/...   (header X-API-KEY = chave NOSSA)
   v
Proxy (Cloudflare Worker + Hono)
   |  1. autentica a chave -> resolve tenant
   |  2. resolve account_id do tenant (do banco, NUNCA do request)
   |  3. checa rate limit
   |  4. injeta master token + DSN + account_id
   v
Unipile (conta-mestra unica)
   v
LinkedIn (conta do cliente)   <- limites do LinkedIn aplicam aqui
```

## Modelo de dados

Migrations 0001-0007 (bootstrap unico em `supabase/bootstrap.sql`):

- `tenants` (id, nome, status, plan, daily_message_limit?,
  daily_invitation_limit?, webhook_url?, webhook_secret?)
- `api_keys` (id, tenant_id, key_hash UNIQUE, status, last_used_at?) -> so o hash
- `connected_accounts` (id, tenant_id, unipile_account_id UNIQUE, provider,
  status active|paused|disconnected) -> uma conta nunca aponta para 2 tenants
- `connect_tokens` (id, tenant_id, token_hash UNIQUE, purpose create|reconnect,
  status pending|used, expires_at) -> auto-conexao (Marco 4), so hash
- `usage_daily` (tenant_id, action, day, count; RPC atomica `increment_usage`)
- `billing_subscriptions` (tenant_id, asaas_customer_id, asaas_subscription_id
  UNIQUE, status pending|active|overdue|canceled)

Todas com RLS ligada sem policy (deny total a anon/authenticated) + REVOKE ALL;
o Worker usa service role e filtra tenant_id no codigo (defesa em profundidade).
A resolucao de `account_id` parte sempre de: API key -> tenant ->
connected_accounts (status active, mais recente).

## Rotas do Worker

| Rota | Auth | O que faz |
|---|---|---|
| `GET /health`, `/openapi.json`, `/docs` | publica | saude + doc (Scalar pinado com SRI) |
| `POST /v1/messages`, `/v1/invitations`, `GET /v1/chats` | X-API-KEY | o proxy (respostas sanitizadas por whitelist) |
| `POST /v1/keys/rotate`, `PUT/GET/DELETE /v1/webhook` | X-API-KEY | self-service do tenant |
| `POST /hooks/connect` | connect_token (uso unico) | callback da auto-conexao (Marco 4) |
| `POST /hooks/account-status`, `/hooks/message-received` | secret em header (fail-closed) | eventos da origem -> status/webhook do tenant |
| `POST /hooks/billing` | asaas-access-token (fail-closed) | pagamento -> pausa/despausa |
| `GET /admin/tenants`, `/admin/usage`, `/admin/capacity` | X-ADMIN-KEY (404 sem chave) | operacao |

## Decisoes de stack (resumo)

- Cloudflare Workers + Hono: sincrono, baixa latencia, global, sem cold-start
  relevante. Alternativa aceitavel: Vercel Functions.
- Supabase (Postgres + RLS) para dados e isolamento.
- Rate limit: Cloudflare KV ou Upstash Redis.
- Docs da API: Scalar a partir de OpenAPI.
- Sem n8n em nenhum caminho (nao serve para API publica sincrona; falha sob
  rajada). Trabalho assincrono da fase 2 usa fila dedicada com retry nativo.
