# Spec, Marco 3: Conjunto V1 de endpoints + rate limit

> Execute em sessao limpa. Contexto: @PRD.md. Regras: @CLAUDE.md.

## Objetivo
Completar os 3 endpoints da V1 e implementar o rate limiter por chave, que
protege as contas de LinkedIn (e a propria equipe testando) do excesso.

## Escopo, os 3 endpoints da V1
1. `POST /v1/messages` (enviar mensagem, ja do Marco 1/2).
2. `POST /v1/invitations` (enviar convite de conexao).
3. `GET /v1/chats` (listar chats, para obter `chat_id`).

## Rate limit
- Contador por chave por janela (Cloudflare KV ou Upstash Redis, decidir aqui).
- Aplicar nas acoes de escrita (mensagem e convite) antes de chamar a Unipile.
- Estourou: responder 429 com header de retry.
- Limites default: partir dos valores conservadores da Unipile
  (https://developer.unipile.com/docs/provider-limits-and-restrictions).
  Registrar os numeros escolhidos em `docs/decisoes.md`.

## Arquivos que devem mudar
- `src/index.ts` / `src/routes/` (rotas de invitations e chats).
- `src/middleware/rateLimit.ts` (implementar contador).
- `src/lib/unipile.ts` (metodos de convite e listar chats).
- `wrangler.jsonc` (binding de KV, se for a escolha).

## Verificacao (criterio de aceite)
- As tres acoes funcionam de ponta a ponta na conta de teste.
- O rate limiter corta o excesso: um teste que estoura a janela recebe 429.
- Isolamento continua valendo para os endpoints novos (convite/chats tambem
  resolvem `account_id` server-side).
- `npm run typecheck` e `npm test` passando.
- Rodar `security-reviewer` no diff.
