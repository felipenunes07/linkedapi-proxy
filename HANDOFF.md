# HANDOFF, LinkedAPI (proxy Unipile)

Snapshot para quem for tocar o projeto de onde paramos. Atualizado em 2026-08-20.

> Leia primeiro [CLAUDE.md](CLAUDE.md) (contexto sempre-carregado e regras
> invioláveis) e [PRD.md](PRD.md) (documento-mãe: porquê, o quê, decisões). Este
> arquivo é só o "onde estamos e o que falta".

## O que é

Camada proxy sobre a Unipile para automação de LinkedIn. Vendemos "a nossa API"
em BRL; por baixo roteamos para a Unipile sob uma única conta-mestra. O nome do
produto é **LinkedAPI** (domínio pretendido `linkedapi.com.br`, ainda não
registrado).

Stack: Cloudflare Workers + Hono (TypeScript), Supabase (Postgres + RLS), rate
limit em Cloudflare KV, docs via Scalar a partir de OpenAPI.

## Status geral

Todo o código da V1 (incluindo o Marco 4) está **pronto e verde**: typecheck +
**62 testes**, com o diff inteiro revisado pelo subagent `security-reviewer`
(achados corrigidos, ver decisões M4.2-M4.10). O que falta é infraestrutura e
prova real: o projeto Supabase antigo sumiu do DNS, o Worker nunca foi
deployado, e as provas ponta a ponta dos Marcos 4 e 5 dependem disso.

| Marco | Escopo | Status |
|---|---|---|
| 1 | Proxy esqueleto: enviar mensagem | ✅ código + verificado no real |
| 2 | Supabase + isolamento multi-tenant | ✅ código + verificado no real |
| 3 | 3 endpoints da V1 + rate limit | ✅ código + verificado no real |
| 5 | Docs (Scalar) + emissão/revogação de chave | ✅ código; **falta prova real** |
| 4 | Auto-conexão (hosted auth Unipile) | ✅ código + 22 testes; **falta prova real** |

Os 3 endpoints da V1: `POST /v1/messages`, `POST /v1/invitations`, `GET /v1/chats`.

## Estado da infraestrutura (verificado em 2026-08-20)

- **Unipile: OK.** O master token autentica; a conta-mestra tem 5 contas
  LinkedIn conectadas (4 com status OK, a do Victor com status `CREDENTIALS`,
  ou seja, sessão caída; usar `npm run connect:reconnect` quando houver deploy).
- **Supabase: SUMIU.** `voojvcdihyymewrhrlti.supabase.co` não resolve no DNS
  (projeto pausado por inatividade ou deletado). Restaurar pelo dashboard do
  Victor, ou criar projeto novo (sa-east-1), reapontar `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` e aplicar as migrations 0001, 0002 e 0003 na
  ordem. Sem banco não há prova real de chave nem de auto-conexão.
- **Cloudflare: sem login.** `wrangler whoami` não autenticado nesta máquina;
  o deploy precisa da conta do Victor (`npx wrangler login`).

## O que entrou em 2026-08-20 (além do que já havia)

- **Endurecimento** (decisões E1-E4 em [docs/decisoes.md](docs/decisoes.md)):
  - Respostas de sucesso agora são projetadas por whitelist em
    [src/lib/sanitize.ts](src/lib/sanitize.ts); o corpo cru da Unipile (que
    expunha `unipile_account_id`) não sai mais. openapi.json documenta as
    formas exatas.
  - `/docs` carrega o Scalar **pinado com SRI** (não mais a versão flutuante).
  - [Migration 0002](supabase/migrations/0002_constraints.sql): unique em
    `connected_accounts.unipile_account_id` + CHECK nos `status`.
- **Marco 4 completo em código** (spec detalhada em
  [specs/marco-4-auto-conexao.md](specs/marco-4-auto-conexao.md)):
  - [Migration 0003](supabase/migrations/0003_connect_tokens.sql): tabela
    `connect_tokens` (token de correlação, só hash, uso único, expira).
  - [scripts/connect.ts](scripts/connect.ts): `npm run connect:link --
    <tenant_id>` e `npm run connect:reconnect -- <tenant_id>` geram o link
    white-label de hosted auth (Recruiter/Sales Navigator desabilitados).
  - [src/routes/connect.ts](src/routes/connect.ts): callback público
    `POST /hooks/connect` com barreira em camadas (throttle KV fail-closed,
    token de uso único consumido atomicamente, propósito amarrado ao status,
    verificação da conta na Unipile com correlação por `name`, unique no
    banco). 22 testes em [test/connect.test.ts](test/connect.test.ts).
- **Testes de gap** ([test/hardening.test.ts](test/hardening.test.ts)):
  sanitização/vazamento, caminho 502 nos 3 endpoints (sem consumir cota),
  JSON malformado, tenant sem conta, limiter de messages, `app.onError`
  (erro não tratado responde `{error: internal_error}` sem detalhe).
- **Security review**: o diff inteiro passou pelo subagent `security-reviewer`;
  o achado bloqueante (account_id do notify não amarrado ao token) e os
  importantes (consumo não atômico, rota pública sem throttle, contas ativas
  múltiplas por tenant, oráculo no 409) foram corrigidos. Registro em
  [docs/decisoes.md](docs/decisoes.md) (M4.2-M4.10).

## O que falta (nada é código; tudo é infra + prova real)

> Checklist executável, em ordem e com os comandos prontos:
> [docs/go-live.md](docs/go-live.md). Os itens abaixo são o resumo.

1. **Banco novo (bloqueia tudo).** Restaurar ou criar projeto Supabase,
   aplicar migrations 0001-0003, seedar 1 tenant e vincular uma conta real
   (`connected_accounts` com um dos account_ids vivos da conta-mestra).
2. **Deploy no workers.dev.** Roteiro abaixo. Preencher `PUBLIC_BASE_URL` no
   `.dev.vars` com a URL resultante (o notify da auto-conexão precisa dela).
3. **Prova real do Marco 5**: `key:issue` -> curl 200 -> `key:revoke` -> 401.
4. **Prova real do Marco 4**: `connect:link` para um tenant de teste, alguém
   de fora conecta o LinkedIn, conferir a linha em `connected_accounts`.
   Aproveitar e reconectar a conta do Victor (`connect:reconnect`).
5. **Isolamento cross-tenant no real**: com uma 2a conta real conectada,
   repetir o teste central (chave A com chat_id real de B deve falhar).
6. **Teste com pessoa real não-dev** usando só chave + `/docs` (promessa da V1).
7. **Registrar `linkedapi.com.br`** e trocar o server do `openapi.json`
   (placeholder) pela URL real.

## Setup local (para o colega rodar)

```bash
npm install
cp .dev.vars.example .dev.vars   # preencha com credenciais reais (pedir ao Victor)
npm run dev                      # Worker local em http://localhost:8787
npm run typecheck                # tsc do Worker + dos scripts
npm test                         # vitest (62 testes)
```

**Segredos NÃO estão no repositório** (regra inviolável #2). O `.dev.vars` é
gitignored. Valores necessários: `UNIPILE_DSN`, `UNIPILE_MASTER_TOKEN`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, e para o Marco 4
`PUBLIC_BASE_URL` (URL pública do Worker, após o deploy). Estrutura em
[.dev.vars.example](.dev.vars.example).

## Roteiro: deploy no workers.dev

Precisa da conta Cloudflare do Victor (login e secrets).

1. `npx wrangler login`
2. `npx wrangler kv namespace create RATE_LIMIT` e colar o `id` retornado no
   [wrangler.jsonc](wrangler.jsonc) (hoje está `REPLACE_WITH_KV_NAMESPACE_ID`).
3. Subir os secrets, um por vez (nunca vão para arquivo):
   `npx wrangler secret put UNIPILE_DSN`,
   `... UNIPILE_MASTER_TOKEN`, `... SUPABASE_URL`, `... SUPABASE_SERVICE_ROLE_KEY`.
4. `npm run deploy` e anotar a URL `https://linkedapi-proxy.<subdominio>.workers.dev`.
5. Conferir: `curl https://<url>/health` deve dar `{"ok":true}`; abrir `/docs`.
6. Preencher `PUBLIC_BASE_URL` no `.dev.vars` com essa URL (para os scripts de
   auto-conexão) e trocar o server do `openapi.json`.

## Roteiro: prova real da chave (critério de aceite do Marco 5)

Pode ser local (`npm run dev`, lê `.dev.vars`) ou contra a URL pública. É real de
qualquer jeito: Supabase real + Unipile real + LinkedIn real.

**Atenção:** o `tenant_id` usado precisa ter uma `connected_account` (linkedin,
ativa) no Supabase, senão até uma chave válida devolve 401 (o `resolveTenant`
retorna null sem conta).

1. `npm run key:issue -- <tenant_id>` → copiar `API key` (`lk_live_...`) e `key_id`.
2. `curl -i http://localhost:8787/v1/chats -H "X-API-KEY: <lk_live_...>"` → espera **200**.
3. `npm run key:revoke -- <key_id>`.
4. Repetir o curl do passo 2 → espera **401** `invalid_api_key`.

200 antes, 401 depois = emissão cria chave que autentica, revogação invalida.

## Roteiro: prova real da auto-conexão (critério de aceite do Marco 4)

Precisa do deploy (o notify da Unipile tem que alcançar o Worker público).

1. Criar um tenant de teste no Supabase (insert em `tenants`).
2. `npm run connect:link -- <tenant_id>` → envia o link a quem vai conectar.
3. A pessoa conclui o wizard (QR code/credenciais; Recruiter/Sales Navigator
   já vêm desabilitados).
4. Conferir a linha nova em `connected_accounts` (tenant certo, status active)
   e o `connect_token` correspondente com status `used`.
5. `npm run key:issue -- <tenant_id>` e um `GET /v1/chats` com a chave: os
   chats são os da conta recém-conectada.

## Convenções que não se reabrem (resumo; detalhe em CLAUDE.md)

- `account_id` SEMPRE resolvido no servidor a partir da API key. Nunca do request.
- Master token e DSN da Unipile nunca saem do servidor (nem log, nem cliente).
- Da API key guardamos só o hash (idem para tokens de auto-conexão).
- Rate limit obrigatório desde a V1 nas ações de escrita.
- Sem n8n. Proxy síncrono.
- Estilo de escrita do time: nunca usar travessão/em-dash.

## Estrutura do repo

| Caminho | O que é |
|---|---|
| `PRD.md` | Documento-mãe |
| `CLAUDE.md` | Contexto sempre-carregado + regras invioláveis |
| `specs/` | Uma spec por marco (todas detalhadas) |
| `src/` | Worker (Hono): pipeline do proxy + callback de auto-conexão |
| `scripts/keys.ts` | Emissão/revogação de chave (standalone Node) |
| `scripts/connect.ts` | Links de auto-conexão/reconexão (standalone Node) |
| `openapi.json` | Spec pública dos 3 endpoints |
| `supabase/migrations/` | Schema + RLS + constraints + connect_tokens |
| `test/` | Testes (destaques: `isolation.test.ts`, `connect.test.ts`) |
| `docs/` | Arquitetura, decisões, notas da Unipile |
| `.claude/` | Agents, skills e hooks do projeto |
