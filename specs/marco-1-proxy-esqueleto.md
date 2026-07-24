# Spec, Marco 1: Proxy esqueleto (o coracao)

> Execute esta spec em uma sessao limpa. Contexto de produto: @PRD.md.
> Regras invioláveis: @CLAUDE.md. Convencoes Unipile: skill `unipile-api`.

## Objetivo
Um Worker com UM endpoint (enviar mensagem) que exercita o caminho critico:
roteamento, manejo de segredo e injecao server-side do `account_id`. Chave
hardcoded e `account_id` seedado (banco entra so no Marco 2).

## Escopo
- Endpoint: `POST /v1/messages` (enviar mensagem em chat existente).
- Autenticacao: header `X-API-KEY` comparado com uma chave fixa (de `.dev.vars`
  ou constante de dev). Ainda sem banco.
- `account_id`: valor seedado no servidor (de `.dev.vars`). IMPORTANT: nao
  aceitar `account_id` do request, mesmo neste marco.
- Roteamento: montar `https://{UNIPILE_DSN}/api/v1/...`, injetar master token no
  header e o `account_id` seedado. Confirmar path/payload reais na doc.

## Fora de escopo (nao fazer agora)
- Supabase, tenants, RLS (Marco 2).
- Convite e listar chats (Marco 3).
- Rate limit (Marco 3).

## Arquivos que devem mudar
- `src/index.ts` (rota e pipeline).
- `src/lib/unipile.ts` (cliente da Unipile: base URL + injecao de token).
- `src/types.ts` (Env bindings e tipos do payload).
- `.dev.vars` (segredos locais; NAO versionar).

## Verificacao (criterio de aceite)
- `npm run typecheck` e `npm test` passando.
- Um `POST /v1/messages` com a chave correta e um `chat_id` + texto de teste
  resulta em mensagem enviada de verdade no LinkedIn conectado (teste manual com
  a conta de teste).
- Sem a chave, ou com chave errada: 401.
- Nenhum segredo (master token, DSN) aparece em resposta ao cliente nem em log.
- Rodar o subagent `security-reviewer` no diff antes de dar como pronto.

## Notas
- Confirme o formato exato do endpoint de envio de mensagem na doc antes de
  codar (skill `unipile-api` ou subagent `unipile-researcher`).
