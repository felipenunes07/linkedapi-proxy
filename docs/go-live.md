# Go-live: do banco restaurado ate a V1 provada

Checklist em ordem. Tudo que era manual virou comando; os passos marcados com
[VOCE] sao os unicos que exigem acao humana fora do terminal.

## A. Banco (pre-requisito de tudo) - FEITO 2026-09-01

- [x] [VOCE] Victor restaurou o projeto `voojvcdihyymewrhrlti` (mesma URL/key).
- [x] [VOCE] `bootstrap.sql` executado no SQL Editor; 6 tabelas + colunas da
      fase 2 conferidas via REST.
- [x] `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`: os valores antigos voltaram a
      valer (mesmo projeto), nada a atualizar.
- [x] Tenants de julho sobreviveram; Tenant A -> conta Márcio, Tenant B ->
      conta Dennis (antigas viraram `disconnected`). Comandos de referencia:

```bash
npm run tenant:create -- "Tenant de teste"
```

```bash
npm run account:link -- <tenant_id> <unipile_account_id>
```

      (o script confere na Unipile que a conta existe e e LinkedIn antes de
      gravar; `npm run tenant:list` mostra o estado)

## B. Prova real do Marco 5 (local, sem deploy) - PASS 2026-09-01

- [x] Terminal 1: `npm run dev` (atencao: usar `http://127.0.0.1:8787`; nesta
      maquina outro processo escuta `localhost:8787` em IPv6)
- [x] Terminal 2:

```bash
npm run prova:chave -- <tenant_id>
```

      Emite chave -> espera 200 -> revoga -> espera 401. PASS = Marco 5 fechado.

## C. Deploy no workers.dev - FEITO 2026-09-01

- [x] `npx wrangler login` (OAuth do Felipe, que tem acesso a conta do Victor;
      `account_id` fixado no wrangler.jsonc).
- [x] KV RATE_LIMIT criado; 9 secrets subidos (4 base + 4 da fase 2 +
      PUBLIC_BASE_URL).
- [x] Deploy: `https://linkedapi-proxy.victor-58a.workers.dev`.
- [x] Smoke: `/health` `{"ok":true}`; `/docs` 200.
- [x] `PUBLIC_BASE_URL` preenchido no `.dev.vars`.
- [x] `server` do `openapi.json` trocado e redeployado.
- [x] Prova da chave contra a URL publica: PASS (2026-09-01).

## D. Prova real do Marco 4 (auto-conexao)

- [x] MECANISMO PASS em producao (2026-09-02): link gerado, wizard concluido,
      notify -> callback consumiu o token e gravou a conta AUTOMATICAMENTE no
      tenant certo, zero toque manual. O follow-up da ancora aconteceu como
      previsto e foi corrigido (M4.11: ancora temporal; a Unipile renomeia a
      conta e nao devolve o token no `name`).
- [ ] DEFERRED (decisao 2026-09-02): a prova com pessoa EXTERNA conectando o
      PROPRIO LinkedIn fica para o PRIMEIRO ONBOARDING REAL de cliente, que e
      a evidencia final. Nao esta concluida; nao bloqueia o avanco. (A conexao
      de teste usou um LinkedIn interno em duplicidade; duplicada removida.)
- [ ] Reconectar a conta do Victor (status CREDENTIALS na conta-mestra):
      `npm run connect:reconnect -- <tenant_id_do_victor>`.

## E. Provas de isolamento e de produto

- [x] Cross-tenant real - PASS 2026-09-01: chave A (Márcio) + `chat_id` real de
      B (Dennis) em `POST /v1/messages` -> Unipile recusou com 403 -> proxy
      devolveu `502 {error: upstream_error, upstream_status: 403}`, nada foi
      enviado. A Unipile recusa; nao precisa validar posse no servidor.
- [ ] DEFERRED (decisao 2026-09-02): pessoa nao-dev com SO chave + `/docs`
      envia mensagem e convite sozinha. Evidencia final no PRIMEIRO ONBOARDING
      REAL de cliente. Nao concluida; nao bloqueia o avanco. Nota: o wizard da
      hosted auth mostra `account.unipile.com` na URL (a promessa "nunca ve a
      palavra Unipile" depende de dominio proprio na hosted auth, config a
      parte na Unipile).

## F. Ativacao da fase 2 (depois do deploy)

- [x] Secrets gerados e em producao (2026-09-01): `ACCOUNT_STATUS_HOOK_SECRET`,
      `MESSAGE_HOOK_SECRET`, `ASAAS_HOOK_TOKEN`, `ADMIN_API_KEY`,
      `PUBLIC_BASE_URL`.
- [x] Webhooks registrados na Unipile (2026-09-01): `account-status`
      (id `0Az3LTd7R4ejVAX_7vE_4g`) e `messaging` (id `bcDRWBK2TCqqF9C8jWxZTg`).
      Smoke do `/hooks/message-received` em producao: sem secret 401, payload
      vazio 400, conta desconhecida `{ok, ignored}`.

- [x] **Asaas SANDBOX validado ponta a ponta (2026-09-03).** Conta sandbox
      criada, `ASAAS_API_KEY` (`$aact_hmlg...`) e
      `ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3` no `.dev.vars`; a key
      foi conferida contra os dois ambientes (sandbox 200, producao 401) antes
      de qualquer escrita. Webhook criado via API (id
      `b85078b7-234a-4f6b-ae17-79b265973c57`), apontando para
      `/hooks/billing`, com `authToken` = `ASAAS_HOOK_TOKEN` e os 3 eventos
      (PAYMENT_CONFIRMED, PAYMENT_RECEIVED, PAYMENT_OVERDUE).
      Provas, no tenant descartavel `aad5c8ef` (nenhuma conta real tocada):
      - `billing:subscribe` criou cliente + assinatura Pix R$57/mes
        (`sub_uxt0yonkyuqn8kjq`), linha em `billing_subscriptions` = `pending`;
      - recebimento confirmado no Asaas -> a ORIGEM chamou nosso webhook e a
        assinatura virou `active` (chain Asaas -> Worker -> Supabase provada);
      - `PAYMENT_OVERDUE` -> assinatura `overdue` E conta do tenant `paused`;
      - `PAYMENT_CONFIRMED` -> assinatura `active` E conta de volta `active`;
      - assinatura desconhecida -> `{ok, ignored}`, sem efeito;
      - gate fail-closed em producao: sem token 401, payload vazio 400.
- [x] **Asaas PRODUCAO configurado (2026-09-03).** `ASAAS_API_KEY` real no
      `.dev.vars` (`$aact_prod_...`, conferida: producao 200, sandbox 401) e
      `ASAAS_BASE_URL` REMOVIDA (default = producao). Webhook criado via API
      (id `d25614cc-959f-48d0-80ea-d06dbd2945a2`), mesma URL, mesmo
      `authToken`, mesmos 3 eventos, alertas de falha para
      felipe.arian@playbooklab.com.br. Nenhuma assinatura real existe ainda; a
      linha de teste do sandbox foi removida de `billing_subscriptions`.
      NOTA: o GET /webhooks nao devolve o `authToken` (mascarado pelo Asaas);
      a mesma chamada foi provada no sandbox, onde o evento real passou pelo
      gate que exige o token. Confirmar no painel se quiser certeza visual.
- [ ] Primeira assinatura real: `npm run billing:subscribe -- <tenant_id>
      "<nome>" <cpf_cnpj> <email>`. ATENCAO: cobra de verdade.
- [ ] Conferir a operacao: `curl -H "X-ADMIN-KEY: ..." <url>/admin/capacity`.

## H. Pix Automatico + painel do cliente (F2.18 a F2.21)

NO AR desde 2026-09-10 (go-live autorizado pelo Felipe): migrations aplicadas
e conferidas, Worker `291a684e-8aa1-4d1e-8e91-5176dd04692e`, landing
`721dd6e6` (producao, branch master), smoke 7/7. Ordem que vale para qualquer
repeticao: migrations ANTES do Worker (Worker novo sem a 0008 quebra o
checkout).

- [x] Migrations 0008 e 0009 aplicadas pelo CLI (2026-09-10). Conferido:
      colunas novas, `portal_tokens` com RLS e sem acesso de `anon`, funcao de
      busca `SECURITY INVOKER`. Referencia: Pelo SQL Editor
      (colar `supabase/migrations/0008_pix_automatico.sql` e depois
      `0009_portal.sql`) ou pelo CLI ja logado nesta maquina:

```bash
supabase db query --linked --project-ref voojvcdihyymewrhrlti -f supabase/migrations/0008_pix_automatico.sql
```

```bash
supabase db query --linked --project-ref voojvcdihyymewrhrlti -f supabase/migrations/0009_portal.sql
```

- [x] Deploy do Worker (2026-09-10, versao `291a684e`):

```bash
npm run deploy
```

- [x] Landing publicada (2026-09-10, deployment `721dd6e6`; repo
      `linkedapi-site`, projeto Pages `linkedapi-site` na conta do Victor):

```bash
bash publicar.sh
```

- [x] Smoke 7/7 ok em 2026-09-10 (so leitura, nada e criado): `GET /portal/status` sem token =
      401; preflight do painel = 204; `/checkout` com CPF invalido = 400;
      chave inexistente = 401:

```bash
npm run smoke
```
- [ ] [VOCE] Confirmar no painel do Asaas de producao que o Pix Automatico
      esta habilitado na conta (sem isso o checkout responde
      `billing_unavailable`).
- [ ] [VOCE] Opcional: e-mail transacional. Conta no Resend, dominio
      verificado, e `npx wrangler secret put RESEND_API_KEY` +
      `npx wrangler secret put EMAIL_FROM`. Sem isso o painel funciona pela
      sessao salva no navegador de quem pagou; plano B do operador:
      `npm run portal:link -- <tenant_id>`.

## I. Cartao recorrente + landing na Vercel (F2.25 a F2.27)

Ordem obrigatoria (o Worker novo grava cartao com `asaas_customer_id` vazio,
o que so a 0010 permite):

1. [x] Migration 0010 (aplicada e conferida em 2026-09-10):

```bash
supabase db query --linked --project-ref voojvcdihyymewrhrlti -f supabase/migrations/0010_checkout_cartao.sql
```

2. [x] Deploy do Worker (2026-09-10, versao `eb5a217e`, ja com o F2.28;
   tambem registra o cron da faxina, "triggers" no wrangler.jsonc):

```bash
npm run deploy
```

3. [x] Webhook do Asaas `d25614cc-959f-48d0-80ea-d06dbd2945a2` (2026-09-10,
   via `PUT /v3/webhooks/{id}` com o mesmo `authToken`): eventos agora sao
   PAYMENT_CONFIRMED, PAYMENT_RECEIVED, PAYMENT_OVERDUE, CHECKOUT_PAID e
   PAYMENT_CHARGEBACK_REQUESTED. Conferido depois: `enabled`, fila nao
   interrompida, `hasAuthToken: true`. O Worker antigo responde 200 ignored
   aos eventos novos, entao a ordem entre este passo e o deploy nao importa.
   - [ ] [VOCE] Site da landing nas informacoes da conta Asaas (Minha Conta >
     Informacoes > Site = `https://landing-api-linkedin.vercel.app`; hoje
     vazio). O checkout de cartao devolve o cliente para esse dominio.
4. [x] Landing: push no `master` do repo da landing publica sozinho na Vercel
   (`landing-api-linkedin.vercel.app`). Feito em 2026-09-10 (push `c12e0ac`
   pela conta felipenunes07; conferido no ar: marca Playbook API, opcao de
   cartao, /painel 200). Manual, se precisar: `bash publicar.sh`.
5. [x] Pages antigo (`linkedapi-site.pages.dev`): `_redirects` publicado em
   2026-09-10 (deployment `e57fcef7`), `/*` para a Vercel com 301, caminho e
   query preservados (conferido em `/`, `/painel` e `/termos?x=1`). NAO
   apagar o projeto enquanto a origem estiver no CORS (o subdominio poderia
   ser tomado).
6. Smoke:

```bash
npm run smoke
```

## G. Acabamento

- [ ] [VOCE] Registrar `linkedapi.com.br` e apontar o custom domain no
      Cloudflare (sem mudanca de codigo; atualizar o server do openapi.json).
- [ ] Atualizar HANDOFF.md com o resultado das provas.
