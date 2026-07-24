---
name: novo-endpoint-proxy
description: Passo a passo para adicionar um novo endpoint ao proxy mantendo o pipeline de seguranca intacto (auth, resolucao server-side de account_id, rate limit, roteamento). Use ao criar qualquer rota nova no Worker.
---

# Adicionar um endpoint ao proxy

Todo endpoint de escrita segue o MESMO pipeline. Nao pule etapas de seguranca.

## Pipeline obrigatorio (nesta ordem)
1. **Autenticar a API key nossa** (header `X-API-KEY`). Comparar por hash contra
   `api_keys`. Rejeitar chave inexistente/revogada com 401.
2. **Resolver tenant e `account_id`** a partir da chave (key -> tenant ->
   connected_accounts). IMPORTANT: o `account_id` vem SO daqui. Se o cliente
   mandar `account_id` no corpo/query, ignore (ou rejeite explicitamente). Nunca
   use o valor do cliente.
3. **Rate limit por chave** (contador por janela, KV/Redis) nas acoes de escrita.
   Estourou, responde 429 antes de chamar a Unipile.
4. **Rotear para a Unipile**: montar `https://{UNIPILE_DSN}/api/v1/...`, injetar
   master token no header e o `account_id` resolvido. Ver skill `unipile-api`.
5. **Registrar uso** (para futuro billing/observabilidade), sem logar segredos
   nem PII.
6. **Normalizar a resposta/erro** antes de devolver ao cliente.

## Checklist antes de dar como pronto
- [ ] Nenhum `account_id`/tenant_id vem do request do cliente.
- [ ] Nenhum segredo em log, resposta ou arquivo versionado.
- [ ] Rate limit aplicado (se for acao de escrita).
- [ ] Teste cobrindo o caminho feliz E a tentativa de agir na conta de outro
      tenant (deve falhar).
- [ ] `npm run typecheck` e `npm test` passando (mostre a saida).
- [ ] Rodar o subagent `security-reviewer` no diff.

## Onde o codigo mora
- Rota: `src/index.ts` (ou modulo em `src/routes/`).
- Auth e resolucao de tenant: `src/middleware/auth.ts`, `src/lib/tenants.ts`.
- Rate limit: `src/middleware/rateLimit.ts`.
- Cliente Unipile: `src/lib/unipile.ts`.
