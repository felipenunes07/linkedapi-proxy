# Pendencias (o que NAO da para fechar so com codigo)

Lista viva. Tudo que esta aqui depende de infra, conta externa, decisao de
negocio ou gente. O codigo correspondente ja esta pronto e testado; quando o
item destravar, o roteiro executavel esta em [go-live.md](go-live.md). O
recorte so das acoes que exigem mao humana (quem faz, como, o que destrava)
esta em [../ACOES-HUMANAS.md](../ACOES-HUMANAS.md).

Atualizado em 2026-08-20.

## Bloqueia tudo

- [ ] **Banco Supabase.** O projeto `voojvcdihyymewrhrlti` (conta do Victor)
      sumiu do DNS. Decisao tomada: Victor restaura/recria e nos passa
      `SUPABASE_URL` + service role key. Depois: colar `supabase/bootstrap.sql`
      no SQL Editor (agora inclui as migrations 0001-0007).
- [ ] **Login Cloudflare** (`npx wrangler login`, conta do Victor) e deploy
      (`npm run deploy:setup` + `npm run deploy`). Sem URL publica nao ha
      hosted auth nem webhooks.

## Provas reais (depois de banco + deploy)

- [ ] Prova da chave (Marco 5): `npm run prova:chave -- <tenant_id>`.
- [ ] Prova da auto-conexao (Marco 4): alguem de fora conecta pelo link.
      CONFIRMAR na primeira rodada: (a) `GET /accounts/{id}` devolve nosso
      token no campo `name` (o callback exige e falha fechado); (b) mapeamento
      de status create=CREATION_SUCCESS / reconnect=RECONNECTED.
- [ ] Isolamento cross-tenant real (chave A + chat_id real de B deve falhar) e
      o guard de posse de chat_id (se a Unipile nao recusar, validar posse no
      servidor antes do envio).
- [ ] Teste da pessoa nao-dev so com chave + `/docs` (promessa da V1).
- [ ] Reconectar a conta do Victor (status CREDENTIALS na conta-mestra).
- [ ] Payload real do webhook `messaging` da origem: conferir os nomes de campo
      assumidos em `/hooks/message-received` (chat_id, message, sender.*) e
      ajustar a whitelist se preciso.

## Fase 2: ativacao (depois do deploy)

- [ ] Gerar e subir os secrets novos (em `.dev.vars` E `wrangler secret put`):
      `ACCOUNT_STATUS_HOOK_SECRET`, `MESSAGE_HOOK_SECRET`, `ASAAS_HOOK_TOKEN`,
      `ADMIN_API_KEY` (e opcionais `SEAT_CAP`, `PUBLIC_BASE_URL` no Worker).
- [ ] Registrar os webhooks na origem: `npm run webhook:register --
      account-status` e `-- messaging`.
- [ ] **Conta Asaas** (criar/usar a da empresa; ACAO DO DONO): gerar
      `ASAAS_API_KEY`, configurar o webhook de cobranca no painel apontando
      para `{PUBLIC_BASE_URL}/hooks/billing` com o token no header
      `asaas-access-token`, e validar no sandbox antes de producao.
- [ ] Primeira assinatura real: `npm run billing:subscribe -- ...` e o ciclo
      pagar -> ativa / atrasar -> pausa comprovado ponta a ponta.

## Negocio / juridico (acao do dono)

- [ ] Registrar `linkedapi.com.br` e apontar o custom domain (trocar o server
      do `openapi.json`).
- [ ] Termos de uso + politica de privacidade + LGPD (tokens e conteudo de
      mensagens de terceiros; PRD reconhece a carga, nada redigido). Revisar
      com advogado.
- [ ] Nota fiscal / regularizacao da cobranca recorrente em BRL.
- [ ] Definir os tiers de plano de verdade (hoje: `basic` + override manual de
      limites por tenant).

## Divida tecnica consciente (nao bloqueia venda inicial)

- [ ] Fila duravel para webhooks do cliente (Cloudflare Queues) com retry
      longo; hoje sao 3 tentativas em `waitUntil`.
- [ ] Contador de rate limit atomico (Durable Object/Upstash) quando houver
      concorrencia real; KV tem overshoot leve documentado.
- [ ] Throttle/caching na autenticacao (3 selects por request; tentativas de
      chave invalida custam query).
- [ ] Onboarding self-service completo (cadastro -> pagamento -> conexao ->
      primeira chave) e painel do cliente/admin com UI.
- [ ] Emissao da primeira chave sem operador (hoje `key:issue` e script).
- [ ] Alertas/monitoramento (erro 5xx, conta desconectada, KV indisponivel,
      assinatura desconhecida no billing) e pagina de status.
- [ ] Se a Unipile documentar assinatura/HMAC no notify da hosted auth, adotar.
- [ ] Achados menores deferidos do security-review da fase 2: paginacao/count
      nas agregacoes de /admin (PostgREST corta em 1000 linhas em silencio);
      distinguir 401 invalid_api_key de conta desconectada/pausada (responder
      409 account_disconnected/account_paused reduz ticket de suporte); teto de
      chaves ativas por tenant na rotacao; mover webhook_url/secret para tabela
      propria (hoje em tenants; qualquer select:* futuro ali vazaria o secret).
