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

- [ ] [VOCE] Conta Asaas: gerar `ASAAS_API_KEY` e configurar o webhook de
      cobranca no painel apontando para `{PUBLIC_BASE_URL}/hooks/billing` com
      o token `ASAAS_HOOK_TOKEN` no header `asaas-access-token` (validar no
      sandbox primeiro: `ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3`).
- [ ] Primeira assinatura: `npm run billing:subscribe -- <tenant_id> "<nome>"
      <cpf_cnpj> <email>`; comprovar pagar -> ativa e atrasar -> pausa.
- [ ] Conferir a operacao: `curl -H "X-ADMIN-KEY: ..." <url>/admin/capacity`.

## G. Acabamento

- [ ] [VOCE] Registrar `linkedapi.com.br` e apontar o custom domain no
      Cloudflare (sem mudanca de codigo; atualizar o server do openapi.json).
- [ ] Atualizar HANDOFF.md com o resultado das provas.
