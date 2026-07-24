# Arquitetura da V1

Resumo carregado sob demanda. A fonte completa e @PRD.md (secoes 5 e 6).

## Dois planos

- **Control plane**: cadastro, emissao de chave, futuramente painel e billing.
  Tolerante a latencia. Fora do coracao da V1.
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

## Modelo de dados (V1)

Tres tabelas, o minimo para provar isolamento:

- `tenants` (id, nome, criado_em, status)
- `api_keys` (id, tenant_id, key_hash, status, criado_em) -> so o hash
- `connected_accounts` (id, tenant_id, unipile_account_id, provider='linkedin',
  status)

Isolamento por RLS: um tenant nunca le dado de outro. A resolucao de
`account_id` parte sempre de: API key -> tenant -> connected_accounts.

Rascunho do schema: `supabase/migrations/0001_init.sql` (revisar no Marco 2).

## Decisoes de stack (resumo)

- Cloudflare Workers + Hono: sincrono, baixa latencia, global, sem cold-start
  relevante. Alternativa aceitavel: Vercel Functions.
- Supabase (Postgres + RLS) para dados e isolamento.
- Rate limit: Cloudflare KV ou Upstash Redis.
- Docs da API: Scalar a partir de OpenAPI.
- Sem n8n em nenhum caminho (nao serve para API publica sincrona; falha sob
  rajada). Trabalho assincrono da fase 2 usa fila dedicada com retry nativo.
