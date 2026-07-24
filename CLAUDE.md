# CLAUDE.md

Camada proxy sobre a Unipile para automacao de LinkedIn. Vendemos "nossa API"
em BRL; por baixo roteamos para a Unipile sob uma unica conta-mestra. O
documento-mae do projeto e @PRD.md. Leia-o antes de decisoes de arquitetura.

## Regras invioláveis (NAO reabrir sem forte justificativa)

1. **IMPORTANT: o `account_id` e SEMPRE resolvido no servidor**, a partir da API
   key autenticada (key -> tenant -> connected_accounts). NUNCA aceite
   `account_id` vindo do corpo/headers/query do request do cliente. Sem isso, o
   cliente A age como o cliente B. Esta e a regra de seguranca mais critica.
2. **IMPORTANT: master token e DSN da Unipile nunca saem do servidor.** Nao vao
   para o cliente, front-end nem logs. Vivem em Worker secrets / `.dev.vars`
   (local). Nao escreva esses valores em nenhum arquivo versionado.
3. **Da API key guardamos apenas o hash.** O valor em claro e exibido uma unica
   vez, na criacao.
4. **Rate limiting e obrigatorio ja na V1.** Enviar convite e enviar mensagem sao
   as acoes que restringem contas no LinkedIn. Limites default conservadores,
   partindo dos recomendados pela Unipile (Provider Limits).
5. **Sem n8n** em nenhum caminho. Proxy e sincrono e de baixa latencia.

## Stack (V1)

- Proxy (data plane): Cloudflare Workers + Hono (TypeScript)
- Banco: Supabase (Postgres) com RLS para isolamento de tenant
- Segredos: Worker secrets (`wrangler secret`); em dev, `.dev.vars` (gitignored)
- Rate limit: Cloudflare KV ou Upstash Redis (contador por chave por janela)
- Docs da API: Scalar a partir de OpenAPI
- SDK Unipile Node opcional; a API HTTP e a fonte da verdade

## Comandos

```bash
npm install            # instala dependencias
npm run dev            # wrangler dev (Worker local em http://localhost:8787)
npm run typecheck      # tsc --noEmit
npm test               # vitest
npm run deploy         # wrangler deploy (so quando pedido)
npx wrangler secret put UNIPILE_MASTER_TOKEN   # define segredo em producao
```

Segredos locais ficam em `.dev.vars` (copie de `.dev.vars.example`).

## Convencoes

- TypeScript estrito. Sem `any` em codigo de roteamento/seguranca.
- O pipeline do proxy segue a ordem: autenticar chave -> resolver tenant ->
  resolver `account_id` (do banco) -> checar rate limit -> injetar master token
  + DSN + account_id -> rotear para a Unipile -> registrar uso -> responder.
- Escopo V1: apenas LinkedIn, apenas 3 endpoints (enviar mensagem, enviar
  convite, listar chats). Nao espelhar os 500+ endpoints da Unipile.
- Nunca logar corpo de request/response que possa conter token ou PII.

## Verificacao (feche o loop)

- O teste que prova o negocio e o de **isolamento multi-tenant**: a chave do
  tenant A nao consegue agir na conta do tenant B, nem passando o `account_id`
  do B no request. Trate esse teste como criterio de aceite, nao como enfeite.
- Sempre rode `npm run typecheck` e `npm test` antes de considerar algo pronto,
  e mostre a saida.

## Estrutura

- `PRD.md` documento-mae (porque + o que + decisoes tecnicas)
- `docs/` contexto sob demanda (arquitetura, decisoes, notas da Unipile)
- `specs/` uma spec auto-contida por marco da V1; execute cada uma em sessao limpa
- `src/` codigo do Worker (esqueleto do pipeline)
- `supabase/migrations/` schema + RLS (rascunho a revisar no Marco 2)

## Estilo de escrita (output do time)

Nunca usar travessao/em-dash. Trocar por virgula, dois-pontos, parenteses ou
reescrever.
