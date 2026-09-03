# Pendencias (o que NAO da para fechar so com codigo)

Lista viva. Tudo que esta aqui depende de infra, conta externa, decisao de
negocio ou gente. O codigo correspondente ja esta pronto e testado; quando o
item destravar, o roteiro executavel esta em [go-live.md](go-live.md). O
recorte so das acoes que exigem mao humana (quem faz, como, o que destrava)
esta em [../ACOES-HUMANAS.md](../ACOES-HUMANAS.md).

Atualizado em 2026-08-20.

## Bloqueia tudo - RESOLVIDO (2026-09-01)

- [x] **Banco Supabase.** Victor restaurou o `voojvcdihyymewrhrlti` (mesma
      URL/key); `bootstrap.sql` aplicado e conferido.
- [x] **Cloudflare.** Deploy feito na conta do Victor:
      `https://linkedapi-proxy.victor-58a.workers.dev` (KV + 9 secrets).

## Provas reais (depois de banco + deploy)

- [x] Prova da chave (Marco 5): PASS em 2026-09-01 (local e workers.dev).
- [ ] Prova da auto-conexao (Marco 4): alguem de fora conecta pelo link.
      CONFIRMADO em 2026-09-02: a Unipile NAO devolve o token no `name` da
      conta (renomeia para o nome do perfil); a ancora agora e temporal
      (decisao M4.11). Status CREATION_SUCCESS confirmado no real.
      REGRA OPERACIONAL: nao conectar conta manualmente no painel da Unipile
      enquanto houver connect_token `create` pendente (janela da ancora).
- [x] Isolamento cross-tenant real: PASS em 2026-09-01 (Unipile recusou com
      403; proxy 502 sem enviar nada; guard de posse desnecessario).
- [ ] Teste da pessoa nao-dev so com chave + `/docs` (promessa da V1).
- [ ] Reconectar a conta do Victor (status CREDENTIALS na conta-mestra).
- [ ] Payload real do webhook `messaging` da origem: conferir os nomes de campo
      assumidos em `/hooks/message-received` (chat_id, message, sender.*) e
      ajustar a whitelist se preciso.

## Fase 2: ativacao (depois do deploy)

- [x] Secrets gerados e em producao (2026-09-01), incluindo `PUBLIC_BASE_URL`.
- [x] Webhooks registrados na origem (2026-09-01/02): `account-status` e
      `messaging`, smoke fail-closed OK.
- [x] **Asaas SANDBOX: validado ponta a ponta em 2026-09-03** (assinatura
      criada, webhook da origem chegando, pagar -> ativa / atrasar -> pausa /
      pagar -> despausa, tudo comprovado). Detalhe em [go-live.md](go-live.md)
      secao F.
- [ ] **Asaas PRODUCAO** (ACAO DO DONO): conta real em asaas.com, API key
      real, mesmo webhook (URL e authToken iguais, e-mail real para alertas de
      falha) e remover `ASAAS_BASE_URL` do `.dev.vars`.
- [ ] Primeira assinatura real de cliente pagante.

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

## Achado do review F2.13 (importante, nao bloqueia o 1o cliente)

- Teto de TENTATIVAS nas escritas: hoje so escrita ACEITA consome cota (M3.10,
  correto), mas tentativas que falham (400/404/502) nao contam em nada: uma
  chave valida pode martelar POST /v1/messages com chat_id arbitrario sem
  limite (custo e risco de throttle na conta-mestra; vetor de enumeracao
  residual apos o F2.13). Fix sugerido: segundo contador KV de tentativas
  (aceitas + falhas) com teto ~10x o limite diario, checado no middleware,
  fail-closed. Nao viola M3.10.
