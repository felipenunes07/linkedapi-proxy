# HANDOFF, LinkedAPI (proxy Unipile)

Snapshot para quem for tocar o projeto de onde paramos. Atualizado em 2026-07-31.

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

O núcleo da V1 está **pronto em código e verde** (typecheck + 26 testes). Falta a
prova real ponta a ponta (deploy + emissão de chave contra o Supabase real) e o
Marco 4.

| Marco | Escopo | Status |
|---|---|---|
| 1 | Proxy esqueleto: enviar mensagem | ✅ código + verificado no real |
| 2 | Supabase + isolamento multi-tenant | ✅ código + verificado no real |
| 3 | 3 endpoints da V1 + rate limit | ✅ código + verificado no real |
| 5 | Docs (Scalar) + emissão/revogação de chave | ✅ código; **falta prova real** |
| 4 | Auto-conexão (hosted auth Unipile) | ⛔ não iniciado, é a próxima rota |

Os 3 endpoints da V1: `POST /v1/messages`, `POST /v1/invitations`, `GET /v1/chats`.

## O que está pronto (Marco 5, último commit)

- `openapi.json`: spec dos 3 endpoints, security scheme `X-API-KEY`, envelopes de
  sucesso/erro. Não cita Unipile/DSN/`account_id` (regra de ouro: a doc "é a nossa
  API").
- Rotas públicas (sem auth) no [src/index.ts](src/index.ts): `GET /openapi.json` e
  `GET /docs` (Scalar via CDN).
- [scripts/keys.ts](scripts/keys.ts): `npm run key:issue -- <tenant_id>` e
  `npm run key:revoke -- <key_id>`, via PostgREST + service role. Grava só o hash
  SHA-256; imprime a chave em claro uma única vez no stdout.
- [src/lib/hash.ts](src/lib/hash.ts): `hashApiKey` compartilhado entre o Worker
  (auth) e o script, para os hashes nunca divergirem.

## O que falta (para fechar a V1 core)

1. **Deploy no workers.dev + prova real da chave.** Ainda não rodou contra
   infra real; os testes usam mocks. Roteiro completo abaixo. Isso fecha o
   critério de aceite do Marco 5: entregar chave + link de doc a um testador e
   ele usar sozinho, sem nunca ver a palavra "Unipile".
2. **Registrar `linkedapi.com.br`.** Não bloqueia nada: a URL gratuita
   `*.workers.dev` cobre o interim (deploy, docs, e a callback do Marco 4). O
   custom domain é só configuração no Cloudflare depois, sem mudança de código.
   No `openapi.json` o server `https://api.linkedapi.com.br` é placeholder a
   trocar pela URL real (workers.dev por enquanto).
3. **Marco 4, auto-conexão** (próxima rota escolhida). Ver
   [specs/marco-4-auto-conexao.md](specs/marco-4-auto-conexao.md). Executar em
   sessão limpa, como as outras specs. Constrói a hosted auth da Unipile: link
   white-label, callback grava `account_id` em `connected_accounts`, desabilita
   Recruiter/Jobs.

## Setup local (para o colega rodar)

```bash
npm install
cp .dev.vars.example .dev.vars   # preencha com credenciais reais (pedir ao Victor)
npm run dev                      # Worker local em http://localhost:8787
npm run typecheck                # tsc do Worker + do script
npm test                         # vitest (26 testes, destaque: isolamento)
```

**Segredos NÃO estão no repositório** (regra inviolável #2). O `.dev.vars` é
gitignored. Peça ao Victor os valores para preencher: `UNIPILE_DSN`,
`UNIPILE_MASTER_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (e, para o
Marco 1 legado, `UNIPILE_ACCOUNT_ID`). Estrutura em
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

## Roteiro: prova real da chave (critério de aceite do Marco 5)

Pode ser local (`npm run dev`, lê `.dev.vars`) ou contra a URL pública. É real de
qualquer jeito: Supabase real + Unipile real + LinkedIn real.

**Atenção:** o `tenant_id` usado precisa ter uma `connected_account` (linkedin,
ativa) no Supabase, senão até uma chave válida devolve 401 (o `resolveTenant`
retorna null sem conta). Use o tenant já seedado no Marco 2.

1. `npm run key:issue -- <tenant_id>` → copiar `API key` (`lk_live_...`) e `key_id`.
2. `curl -i http://localhost:8787/v1/chats -H "X-API-KEY: <lk_live_...>"` → espera **200**.
3. `npm run key:revoke -- <key_id>`.
4. Repetir o curl do passo 2 → espera **401** `invalid_api_key`.

200 antes, 401 depois = emissão cria chave que autentica, revogação invalida.

## Convenções que não se reabrem (resumo; detalhe em CLAUDE.md)

- `account_id` SEMPRE resolvido no servidor a partir da API key. Nunca do request.
- Master token e DSN da Unipile nunca saem do servidor (nem log, nem cliente).
- Da API key guardamos só o hash.
- Rate limit obrigatório desde a V1 nas ações de escrita.
- Sem n8n. Proxy síncrono.
- Estilo de escrita do time: nunca usar travessão/em-dash.

## Estrutura do repo

| Caminho | O que é |
|---|---|
| `PRD.md` | Documento-mãe |
| `CLAUDE.md` | Contexto sempre-carregado + regras invioláveis |
| `specs/` | Uma spec por marco (Marco 4 é o próximo) |
| `src/` | Worker (Hono): pipeline do proxy |
| `scripts/keys.ts` | Emissão/revogação de chave (standalone Node) |
| `openapi.json` | Spec pública dos 3 endpoints |
| `supabase/migrations/` | Schema + RLS |
| `test/` | Testes (destaque: `isolation.test.ts`) |
| `docs/` | Arquitetura, decisões, notas da Unipile |
| `.claude/` | Agents, skills e hooks do projeto |
