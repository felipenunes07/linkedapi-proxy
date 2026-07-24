# Spec, Marco 5: Documentacao minima e emissao de chave

> Execute em sessao limpa. Contexto: @PRD.md secao 9. Regras: @CLAUDE.md.
> Marcos 1 a 3 prontos e verificados no real (3 endpoints + rate limit +
> isolamento). Este marco entrega a camada que torna a V1 usavel por alguem de
> fora do time, sem explicacao verbal.

## Objetivo
Entregar a uma pessoa de teste uma chave + um link de doc, e ela consegue enviar
mensagem e convite sozinha, sem nunca ver a palavra "Unipile". Esse e o criterio
de sucesso da V1.

## Escopo (3 entregaveis)

### 1. Emissao/revogacao de chave (script)
Codificar o que hoje e feito na mao. Um script Node standalone (sem Worker):
- `npm run key:issue -- <tenant_id>`: gera chave `lk_live_<hex aleatorio>`, grava
  SOMENTE o hash SHA-256 (hex) em `api_keys` (tenant_id + key_hash + status=active)
  via PostgREST + service role, e imprime o valor em claro UMA vez.
- `npm run key:revoke -- <key_id>`: PATCH `status=revoked` (nunca hard-delete;
  mantem trilha de auditoria).
- Le `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` de `.dev.vars`/env. Segredo
  nunca vai para log nem arquivo versionado. O valor em claro so aparece no
  stdout, na emissao.
- IMPORTANT: o hash TEM que ser identico ao do Worker. Extrair `hashApiKey` de
  `src/lib/tenants.ts` para um `src/lib/hash.ts` compartilhado (SHA-256 hex de
  UTF-8) e usar nos dois lados, para nao divergir.

### 2. OpenAPI dos 3 endpoints da V1
- `openapi.json` (ou `.yaml`) descrevendo: `POST /v1/messages`, `POST /v1/invitations`,
  `GET /v1/chats`.
- Security scheme: `apiKey` no header `X-API-KEY`.
- Documentar o envelope de sucesso (`{ ok, data }`) e o de erro
  (`{ error, upstream_status? }`), com os 400/401/429/502.
- Regra de ouro: a doc e "a nossa API". NAO citar Unipile, DSN, provider, master
  token, nem `account_id` (ele e resolvido no servidor; nao e parametro do
  cliente). O `provider_id` do convite entra como "id do destinatario".

### 3. Renderizar a doc com Scalar
- Servir a doc pelo proprio Worker, publica (sem auth), para o testador so abrir
  o link:
  - `GET /openapi.json`: retorna a spec.
  - `GET /docs`: HTML do Scalar (via `<script>` do CDN) apontando para
    `/openapi.json`.
- Conferir que nada de segredo/infra aparece no HTML nem na spec.

## Arquivos que devem mudar
- `scripts/keys.ts` (emitir/revogar) + entradas `key:issue`/`key:revoke` no `package.json`.
- `src/lib/hash.ts` (novo) e `src/lib/tenants.ts` (passa a importar de `hash.ts`).
- `openapi.json` (novo).
- `src/index.ts` (rotas `GET /openapi.json` e `GET /docs`, publicas).

## Verificacao (criterio de aceite)
- Uma pessoa nao-desenvolvedora recebe chave + link e consegue enviar mensagem e
  convite sozinha, sem nunca ver a palavra "Unipile".
- `npm run key:issue` cria a chave, e ela autentica no proxy (200). `key:revoke`
  invalida (401 depois disso).
- Busca por "unipile", "dsn", "master", "account_id" no HTML de `/docs` e no
  `openapi.json` nao retorna nada sensivel.
- `npm run typecheck` e `npm test` passando.
- Rodar `security-reviewer` no diff (a doc publica e a superficie nova: garantir
  que nao expoe segredo nem aceita `account_id` do cliente).
