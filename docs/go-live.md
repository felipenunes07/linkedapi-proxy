# Go-live: do banco restaurado ate a V1 provada

Checklist em ordem. Tudo que era manual virou comando; os passos marcados com
[VOCE] sao os unicos que exigem acao humana fora do terminal.

## A. Banco (pre-requisito de tudo)

- [ ] [VOCE] Victor restaura o projeto Supabase (ou cria um novo, sa-east-1).
- [ ] [VOCE] Colar [supabase/bootstrap.sql](../supabase/bootstrap.sql) no SQL
      Editor do projeto e executar (e as migrations 0001-0007 em um arquivo so;
      idempotente, rodar de novo nao quebra).
- [ ] Atualizar `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` no `.dev.vars`.
- [ ] Criar o tenant de teste e vincular uma conta viva da conta-mestra:

```bash
npm run tenant:create -- "Tenant de teste"
```

```bash
npm run account:link -- <tenant_id> <unipile_account_id>
```

      (o script confere na Unipile que a conta existe e e LinkedIn antes de
      gravar; `npm run tenant:list` mostra o estado)

## B. Prova real do Marco 5 (local, sem deploy)

- [ ] Terminal 1: `npm run dev`
- [ ] Terminal 2:

```bash
npm run prova:chave -- <tenant_id>
```

      Emite chave -> espera 200 -> revoga -> espera 401. PASS = Marco 5 fechado.

## C. Deploy no workers.dev

- [ ] [VOCE] `npx wrangler login` (conta Cloudflare do Victor).
- [ ] Setup em um comando (cria KV, preenche wrangler.jsonc, sobe os 4 secrets):

```bash
npm run deploy:setup
```

- [ ] `npm run deploy` e anotar a URL.
- [ ] Smoke: `curl https://<url>/health` da `{"ok":true}`; abrir `/docs`.
- [ ] Preencher `PUBLIC_BASE_URL` no `.dev.vars` com a URL.
- [ ] Trocar o primeiro `server` do `openapi.json` pela URL e redeployar.
- [ ] Repetir a prova da chave contra a URL publica:
      `npm run prova:chave -- <tenant_id> https://<url>`.

## D. Prova real do Marco 4 (auto-conexao)

- [ ] Gerar link para um tenant de teste: `npm run connect:link -- <tenant_id>`.
- [ ] [VOCE] Alguem de fora conecta o proprio LinkedIn pelo link (sem tocar no
      painel da Unipile).
- [ ] Conferir com `npm run tenant:list`: conta nova no tenant certo, ativa.
      No Supabase, o `connect_token` correspondente deve estar `used`.
- [ ] IMPORTANT: se o callback responder 401 `account_verification_failed` com
      fluxo legitimo, e o follow-up da spec: confirmar se a Unipile devolve o
      nosso token no campo `name` de `GET /accounts/{id}` e ajustar a ancora
      (specs/marco-4-auto-conexao.md, follow-ups).
- [ ] Reconectar a conta do Victor (status CREDENTIALS na conta-mestra):
      `npm run connect:reconnect -- <tenant_id_do_victor>`.

## E. Provas de isolamento e de produto

- [ ] Cross-tenant real: com 2 tenants de contas reais, chave A + `chat_id`
      real de B tem que falhar (e o follow-up de posse de chat_id do Marco 3;
      se a Unipile nao recusar, validar posse no servidor antes do envio).
- [ ] Pessoa nao-dev recebe SO chave + link do `/docs` e envia mensagem e
      convite sozinha, sem nunca ver a palavra Unipile (promessa da V1).

## F. Ativacao da fase 2 (depois do deploy)

- [ ] Gerar os secrets novos e subir em `.dev.vars` E producao
      (`npx wrangler secret put <NOME>`): `ACCOUNT_STATUS_HOOK_SECRET`,
      `MESSAGE_HOOK_SECRET`, `ASAAS_HOOK_TOKEN`, `ADMIN_API_KEY`; e no Worker
      tambem `PUBLIC_BASE_URL` (para o link de reconexao automatico).
- [ ] Registrar os webhooks da origem:

```bash
npm run webhook:register -- account-status
```

```bash
npm run webhook:register -- messaging
```

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
