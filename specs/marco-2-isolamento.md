# Spec, Marco 2: Camada de dados e isolamento multi-tenant

> Execute em sessao limpa. Contexto: @PRD.md. Regras: @CLAUDE.md.
> Este e o marco que prova o nucleo do negocio.

## Objetivo
Substituir o hardcode do Marco 1 por Supabase. A API key passa a resolver
tenant -> `account_id` a partir do banco. Provar que um tenant nao age pela
conta de outro.

## Escopo
- Tres tabelas (ver `supabase/migrations/0001_init.sql`, revisar antes de aplicar):
  `tenants`, `api_keys` (so hash), `connected_accounts`.
- RLS habilitado: um tenant nunca le dado de outro.
- Auth real: `X-API-KEY` -> hash -> `api_keys` -> `tenant_id`.
- Resolucao: `tenant_id` -> `connected_accounts` -> `unipile_account_id`.
- IMPORTANT: o `account_id` vem SO dessa cadeia. Se o request trouxer
  `account_id`/`tenant_id`, ignore ou rejeite. Nunca use o valor do cliente.

## Fora de escopo
- Convite e listar chats (Marco 3), rate limit (Marco 3), hosted auth (Marco 4).

## Arquivos que devem mudar
- `src/middleware/auth.ts` (autenticar chave por hash, carregar tenant).
- `src/lib/tenants.ts` (resolver `account_id` do tenant).
- `src/lib/supabase.ts` (cliente; service role key so no servidor).
- `src/index.ts` (usar o middleware).
- `supabase/migrations/0001_init.sql` (finalizar schema + RLS).

## Verificacao (criterio de aceite, o teste que prova o negocio)
- Seed de DOIS tenants (A e B), cada um com sua chave e seu `unipile_account_id`.
- Chave A envia mensagem: sai pela conta de A.
- Chave B envia mensagem: sai pela conta de B.
- **Isolamento**: chave A NAO consegue agir pela conta de B, mesmo passando o
  `account_id` (ou `tenant_id`) de B no corpo/query do request. Deve falhar ou
  ignorar o valor injetado e usar o de A.
- Teste automatizado em `test/isolation.test.ts` cobrindo o caso acima.
- `npm run typecheck` e `npm test` passando (mostre a saida).
- Rodar `security-reviewer` no diff (foco em isolamento e service role key).

## Notas
- `key_hash`: usar hash forte (ex.: SHA-256 do segredo com salt, ou o padrao
  que o time definir). Nunca guardar a chave em claro.
- Cuidado com service role key: ela contorna RLS. Toda query deve filtrar por
  `tenant_id` no codigo mesmo assim (defesa em profundidade).
