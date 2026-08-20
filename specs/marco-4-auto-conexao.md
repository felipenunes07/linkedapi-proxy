# Spec, Marco 4: Auto-conexao (hosted auth white-label)

> Detalhada e implementada em 2026-08-20. Contexto: @PRD.md secao 9.
> Pesquisa da API em https://developer.unipile.com/docs/hosted-auth e
> https://developer.unipile.com/reference/hostedcontroller_requestlink.

## Objetivo

Hosted auth da Unipile white-label: o proprio usuario conecta seu LinkedIn sem
tocar (nem ver) o painel da Unipile. O operador gera um link, envia ao cliente,
o cliente conclui o wizard, e o `account_id` resultante e gravado sozinho em
`connected_accounts`, no tenant certo.

## Como a hosted auth funciona (fatos da doc)

- `POST /api/v1/hosted/accounts/link` (com o master token) devolve
  `{ object: "HostedAuthURL", url }`. Corpo: `type` (`create` | `reconnect`),
  `providers: ["LINKEDIN"]` (so no create), `reconnect_account` (so no
  reconnect), `api_url`, `expiresOn` (ISO 8601 UTC com ms), `name`,
  `notify_url`, `single_use`, `disabled_features`, redirects opcionais.
- O campo `name` e o mecanismo oficial de correlacao: o valor que enviamos
  volta no POST que a Unipile faz ao `notify_url`:
  `{ "status": "CREATION_SUCCESS" | "RECONNECTED", "account_id": "...", "name": "..." }`.
- IMPORTANT: o notify NAO tem assinatura/HMAC documentado. O payload sozinho
  nao prova nada; a autenticidade vem do nosso token + verificacao upstream
  (abaixo).
- `disabled_features` aceita `linkedin_recruiter`, `linkedin_sales_navigator`
  e `linkedin_organizations_mailboxes`. Nao existe toggle especifico de "Jobs"
  na doc; Recruiter/Sales Navigator cobrem o D7 na pratica.

## Desenho de seguranca (a parte que importa)

O callback e a UNICA rota publica que escreve no banco. Barreira em camadas
(endurecida apos security-review de 2026-08-20):

1. **Throttle (KV, fail-closed).** Teto de tentativas por token (5/dia) e por
   IP (100/dia) ANTES de tocar banco ou Unipile; `name` tem teto de tamanho
   (200) antes do hash. Sem binding de KV a rota recusa com 500 (regra #4).
2. **Token opaco de uso unico, consumido ATOMICAMENTE.** `scripts/connect.ts`
   gera `lk_conn_` + 32 bytes aleatorios (256 bits), grava SO o hash em
   `connect_tokens` (migration 0003) e envia o claro no campo `name` do link.
   O callback consome o token com UPDATE condicional (`pending` -> `used`,
   checando validade) ANTES de qualquer escrita: replay, reuso e corrida
   morrem aqui. E o token que decide a qual tenant a conta vai; NUNCA
   qualquer id vindo do payload. Token queimado em fluxo que falha depois e o
   comportamento seguro: o operador gera outro link.
3. **Proposito amarrado ao status.** Token `create` so aceita
   `CREATION_SUCCESS`; token `reconnect` so aceita `RECONNECTED`. Um token
   nunca serve para o outro fluxo.
4. **Verificacao upstream com correlacao forte.** O Worker confirma na propria
   Unipile (`GET /api/v1/accounts/{account_id}`) que a conta existe na NOSSA
   conta-mestra e e `LINKEDIN`. No `create`, exige ainda que o campo `name`
   da conta seja o NOSSO token (e o mecanismo oficial de correlacao da hosted
   auth: o que enviamos no link volta na conta): um notify forjado apontando
   uma conta alheia da conta-mestra NAO passa. No `reconnect`, o callback SO
   reativa a conta que o proprio tenant ja tem; qualquer outro account_id e
   rejeitado.
5. **Unique no banco.** `connected_accounts.unipile_account_id` e unique
   (migration 0002): mesmo sob corrida, uma conta nunca aponta para dois
   tenants.

Regras derivadas:
- Conta ja vinculada a OUTRO tenant: resposta 200 GENERICA (sem oraculo de
  "essa conta existe e e de outro tenant"); a anomalia sai por `console.error`
  so com o uuid interno do token. Nunca re-vincula.
- Conta ja vinculada ao MESMO tenant (re-emissao legitima): idempotente,
  reativa (`status: active`). Conta `paused` (ex.: inadimplencia) NAO reativa
  por conexao/reconexao: pausa e decisao de negocio.
- 1 seat = 1 conta: ao vincular conta nova, as demais contas ativas do tenant
  viram `disconnected` (e `resolveTenant` ordena por `created_at desc` como
  defesa extra contra linha arbitraria).
- Status desconhecido no notify: 200 `{ok, ignored}` sem efeito e sem consumir
  token.
- Nada do payload (token, account_id) e logado nem ecoado na resposta; os
  sinais internos carregam apenas o uuid da linha do token.

## Superficies novas

| Onde | O que |
|---|---|
| `POST /hooks/connect` (Worker, publico) | Callback do notify. `src/routes/connect.ts`. NAO entra no `openapi.json` (e infra, nao superficie do cliente; nome neutro, sem vendor). |
| `npm run connect:link -- <tenant_id>` | Gera link de conexao para conta nova (`type: create`). |
| `npm run connect:reconnect -- <tenant_id>` | Gera link de reconexao da conta do tenant (`type: reconnect`). |
| `connect_tokens` (migration 0003) | Tokens de correlacao, so hash. |
| `PUBLIC_BASE_URL` (.dev.vars / env do script) | Base do `notify_url`. Preencher apos o deploy. |

Parametros fixos do link: `single_use: true`, validade 2h,
`disabled_features: [linkedin_recruiter, linkedin_sales_navigator,
linkedin_organizations_mailboxes]` (D7), `providers: ["LINKEDIN"]`.
Redirects opcionais via `CONNECT_SUCCESS_REDIRECT_URL` /
`CONNECT_FAILURE_REDIRECT_URL` (com `bypass_success_screen` quando ha sucesso
custom).

## Verificacao (criterio de aceite)

- Testes automatizados (`test/connect.test.ts`): vinculo ao tenant certo,
  consumo atomico/replay, proposito trocado, correlacao por `name`, conflito
  cross-tenant sem oraculo, reconexao restrita a conta do tenant, conta
  pausada, throttle e fail-closed sem KV. FEITO (22 testes).
- Prova real (pendente, precisa de deploy + banco): alguem que nao e da equipe
  conecta o proprio LinkedIn pelo link e sai com um `account_id` funcionando em
  `connected_accounts`, sem tocar no painel da Unipile.

## Follow-ups conscientes

- O notify sem assinatura e mitigado por token de uso unico + verificacao
  upstream com correlacao por `name`; se a Unipile documentar HMAC, adotar.
- CONFIRMAR NO PRIMEIRO TESTE REAL: (a) que `GET /accounts/{id}` devolve o
  nosso token no campo `name` da conta criada via hosted auth (o codigo exige
  isso e FALHA FECHADO; se a Unipile nao devolver, ajustar a checagem com
  outra ancora, ex. `created_at` da conta posterior ao do token); (b) que o
  reconnect notifica `RECONNECTED` e o create `CREATION_SUCCESS` (mapeamento
  estrito no codigo).
- `GET /hooks/connect` nao existe (so POST); a Unipile nao faz GET de validacao.
- Posse de `chat_id` (pre-existente, Marco 3): rodar o teste real cross-tenant
  antes de clientes; se a Unipile nao recusar chat de outra conta mesmo com o
  guard de account_id, validar posse no servidor antes do envio.
