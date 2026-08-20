# Spec, Fase 2: operacao SaaS (billing, webhooks, planos, admin)

> Implementada em codigo em 2026-08-20, na sequencia do Marco 4. Este arquivo
> documenta o que foi construido e por que. Decisoes numeradas (F2.x) em
> @docs/decisoes.md; o que ainda depende de infra/conta externa esta em
> @docs/pendencias.md.

## Objetivo

Transformar o proxy provado na V1 em uma operacao vendavel: cobrar por Pix,
pausar inadimplente, avisar o cliente quando a sessao do LinkedIn cair (com
link de reconexao automatico), repassar eventos por webhook assinado, permitir
tiers de limite por tenant, dar autonomia minima ao cliente (trocar chave,
configurar webhook) e dar visao de operacao ao dono (admin + capacidade de
seats + uso persistente).

## O que foi construido

### 1. Planos e limites por tenant (migration 0004)

`tenants` ganhou `plan` (default `basic`) e overrides opcionais
`daily_message_limit` / `daily_invitation_limit` (CHECK no teto SEGURO do
provedor: 1..150 e 1..100; NULL = default do plano basico, 80/30, agora em
`src/lib/limits.ts`). O `resolveTenant`
carrega os overrides na mesma query do status e o rate limiter usa SEMPRE
`tenant.limits` (nunca nada do request). Vender um tier vira um UPDATE no
banco, sem deploy.

### 2. Uso persistente e auditoria de chave (migration 0005)

O contador KV do rate limit expira em 2 dias; ele protege, nao fatura. A tabela
`usage_daily` (tenant, acao, dia, count) guarda o historico via RPC atomica
`increment_usage` (SECURITY DEFINER, execute revogado dos papeis publicos).
`api_keys.last_used_at` registra o ultimo uso de cada chave.

Escrita SEMPRE best-effort pos-resposta (`fireAndForget` -> `waitUntil`):
telemetria nunca atrasa nem derruba uma request do cliente; a fonte do rate
limit continua sendo o KV.

### 3. Self-service do tenant (atras do auth, documentado no openapi.json)

- `POST /v1/keys/rotate`: emite chave nova e revoga A CHAVE USADA NA CHAMADA.
  Ordem cria-antes-de-revogar (falha nunca deixa o tenant sem chave). So o
  hash persiste; o claro aparece uma vez na resposta.
- `PUT /v1/webhook`: registra a url e gera o secret de assinatura (`lk_whsec_`
  + 256 bits), exibido uma vez. A url passa por validacao anti-SSRF (so
  https:443, sem credencial embutida, sem IP literal/localhost/.internal, max
  500 chars) e a entrega usa `redirect: manual` + timeout de 5s. `GET` mostra a
  url (nunca o secret); `DELETE` remove.

### 4. Webhooks assinados para o cliente (`src/lib/webhooks.ts`, migration 0006)

Todo evento e um POST JSON `{type, data}` com:

```
X-Webhook-Event:     <tipo>
X-Webhook-Timestamp: <unix segundos>
X-Webhook-Signature: sha256=HMAC_SHA256(secret, "{timestamp}.{corpo}")
```

Entrega com ate 3 tentativas (0s/2s/5s) dentro de `waitUntil`. Fila duravel com
retry longo (Queues) fica para depois (pendencias). Excecao consciente a regra
"so hash no banco": `tenants.webhook_secret` fica recuperavel porque precisa
assinar cada evento; e gerado por nos, nunca escolhido pelo cliente, e vive em
tabela service-role-only.

### 5. Hooks de evento da origem (`src/routes/eventHooks.ts`)

Tres rotas publicas, todas com gate de secret compartilhado em header,
comparado por hash (timing-safe), FAIL-CLOSED (sem o secret no env, 500; sem
KV, 500) e com throttle diario em KV (por IP e por conta/assinatura, mesma lib
do /hooks/connect):

- `POST /hooks/account-status` (header `x-hook-secret` =
  `ACCOUNT_STATUS_HOOK_SECRET`; registrado na origem por
  `npm run webhook:register -- account-status`). Sessao caiu (CREDENTIALS/
  DISCONNECTED/ERROR/STOPPED): antes de derrubar, o Worker CONFIRMA o status na
  origem (payload dizendo "caiu" com a origem dizendo OK e ignorado; nunca
  confiar so no payload); ai a conta `active` vira `disconnected` e o tenant
  recebe `account.disconnected` com um **link de reconexao gerado na hora**
  (mesmo desenho do Marco 4: connect_token proposito reconnect, so hash, uso
  unico, 2h). Falha ao gerar o link degrada para notificacao sem link, nunca
  engole o evento. Sessao voltou (OK/RECONNECTED/...): `disconnected` vira
  `active` + evento `account.reconnected`. Conta `paused` NUNCA muda por status
  de sessao. Updates filtram o status atual (idempotentes sob retry).
- `POST /hooks/message-received` (header `x-hook-secret` =
  `MESSAGE_HOOK_SECRET`; registrado por `webhook:register -- messaging`).
  Resolve o tenant pela conta NO BANCO (nunca pelo payload), projeta o evento
  por whitelist (chat_id, message_id, text, attendee_provider_id, sender_name,
  timestamp; `account_id` e campos internos NUNCA saem) e entrega assinado.
- `POST /hooks/billing` (header `asaas-access-token` = `ASAAS_HOOK_TOKEN`).
  `PAYMENT_OVERDUE`: assinatura `overdue` + contas ativas do tenant viram
  `paused` (regra do PRD: pausa, nunca deleta). `PAYMENT_CONFIRMED/RECEIVED`:
  `active` + despausa. Assinatura resolvida por `billing_subscriptions`
  (migration 0007); evento/assinatura desconhecidos = 200 ignored.

### 6. Billing Asaas (migration 0007 + `scripts/billing.ts`)

`npm run billing:subscribe -- <tenant_id> "<nome>" <cpf_cnpj> <email>` cria
cliente + assinatura Pix mensal (valor `PLAN_PRICE_BRL`, default 57; primeiro
vencimento em 3 dias) e grava o vinculo. `billing:status` lista. O Worker so
processa o webhook (`/hooks/billing`); nenhuma credencial do Asaas vive nele.

### 7. API administrativa (`src/routes/admin.ts`)

Leitura apenas, atras de `X-ADMIN-KEY` (hash-compare). Sem `ADMIN_API_KEY`
configurada, as rotas respondem 404 (a superficie nem existe).

- `GET /admin/tenants`: tenants + contas + chaves ativas + last_used_at +
  status de billing.
- `GET /admin/usage?from&to`: historico de `usage_daily` (datas validadas por
  formato fechado).
- `GET /admin/capacity`: contas ativas no banco vs contas na conta-mestra vs
  teto de seats (`SEAT_CAP`, default 10). E o mecanismo central da economia do
  negocio (fracionar o piso de ~10 contas).

## Verificacao

- `npm run typecheck` + `npm test`: 100 testes verdes (14 arquivos), cobrindo
  limites por tenant, rotacao de chave, config de webhook (incl. destinos
  perigosos rejeitados), os tres hooks (gate/fail-closed/confirmacao upstream/
  transicoes/pausa intocavel/whitelist), assinatura HMAC verificavel, retry de
  entrega e a API admin (incl. medidor de capacidade que nao finge zero).
- Security review dedicado da fase 2: nenhum bloqueante; achados I1-I5 e
  menores corrigidos (registro em docs/decisoes.md F2.12).
- Prova real pendente de infra (banco + deploy + contas externas): ver
  @docs/pendencias.md.

## O que NAO entrou (consciente)

- Onboarding self-service completo (cadastro -> pagamento -> conexao) e
  qualquer UI/painel: hoje o operador roda scripts; painel e fase de
  comercializacao.
- Fila duravel para webhooks (Queues) e retry alem de 3 tentativas.
- Emissao da PRIMEIRA chave pelo cliente (a rotacao exige ja ter chave).
- Nota fiscal, termos de uso, LGPD documental.
