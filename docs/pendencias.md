# Pendencias (o que NAO da para fechar so com codigo)

Lista viva. Tudo que esta aqui depende de infra, conta externa, decisao de
negocio ou gente. O codigo correspondente ja esta pronto e testado; quando o
item destravar, o roteiro executavel esta em [go-live.md](go-live.md). O
recorte so das acoes que exigem mao humana (quem faz, como, o que destrava)
esta em [../ACOES-HUMANAS.md](../ACOES-HUMANAS.md).

Atualizado em 2026-09-10.

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
- [x] **Asaas PRODUCAO configurado em 2026-09-03**: key real no `.dev.vars`,
      `ASAAS_BASE_URL` removida, webhook criado (id `d25614cc...`). Detalhe em
      [go-live.md](go-live.md) secao F.
- [ ] Primeira assinatura real de cliente pagante (unico passo que falta para
      o dinheiro entrar; cobra de verdade).

## Pix Automatico + painel do cliente (F2.18 a F2.21) - codigo pronto

- [x] Checkout com Pix Automatico (F2.18) e painel self-service (F2.20),
      endurecido pelo review (F2.21). 174 testes verdes.
- [x] Landing reescrita so com o que o produto entrega (LinkedIn, 3 endpoints,
      webhooks), sem logos de clientes, "teste gratis", SOC 2 ou 99,9%.
- [x] Termos de uso e politica de privacidade redigidos (landing).
- [x] Migrations 0008 e 0009 em producao (2026-09-10, conferidas).
- [x] Deploy do Worker (`291a684e`) e landing publicada (`721dd6e6`), smoke 7/7.
- [x] Push dos commits (2026-09-10, conta felipenunes07; PR #1 atualizado).
- [x] Pix Automatico habilitado na conta Asaas de producao (API 200, 2026-09-10).
- [ ] Resend (opcional): boas-vindas e "entrar" por e-mail.

## Negocio / juridico (acao do dono)

- [ ] Registrar `linkedapi.com.br` e apontar o custom domain (trocar o server
      do `openapi.json`).
- [ ] Termos de uso + politica de privacidade + LGPD: REDIGIDOS em
      2026-09-10 (termos.html, privacidade.html na landing). Falta preencher
      os dados da empresa (marcados em amarelo) e revisar com advogado,
      incluindo o risco de marca do nome "LinkedAPI".
- [ ] Criar a caixa `contato@linkedapi.com.br` (citada na landing e no painel).
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
- [x] Onboarding self-service completo (cadastro -> pagamento -> conexao ->
      primeira chave) e painel do cliente: FEITO no F2.20/F2.21. Painel de
      admin com UI segue pendente (hoje: API /admin).
- [x] Emissao da primeira chave sem operador: FEITO (`POST /portal/key`).
- [ ] Link do "Entrar" preso ao navegador que pediu (nonce no localStorage,
      hash junto do link, exigido no `/portal/session`). Hoje a mitigacao
      contra "cliente manda o proprio link para uma vitima" sao as
      confirmacoes do painel (review F2.24).
- [ ] Limitar quantos checkouts pendentes seguram vaga (hoje: todos da
      ultima 1h; abandono em massa deixa a venda "esgotada" por ate 1h).
- [ ] Verificacao de posse do e-mail (`contact_email_verified_at`) antes de
      liberar o "entrar" por e-mail. Hoje a mitigacao e mostrar o e-mail na
      tela do Pix e deixar corrigir ate o 1o pagamento (review F2.20, I2).
- [ ] Alertas/monitoramento (erro 5xx, conta desconectada, KV indisponivel,
      assinatura desconhecida no billing) e pagina de status.
- [ ] Se a Unipile documentar assinatura/HMAC no notify da hosted auth, adotar.
- [ ] Achados menores deferidos do security-review da fase 2: paginacao/count
      nas agregacoes de /admin (PostgREST corta em 1000 linhas em silencio);
      ~~distinguir 401 de conta desconectada/pausada~~ FEITO no F2.22
      (402 account_paused, 409 account_disconnected/linkedin_not_connected); teto de
      chaves ativas por tenant na rotacao; mover webhook_url/secret para tabela
      propria (hoje em tenants; qualquer select:* futuro ali vazaria o secret).

## Achado do review F2.13 - RESOLVIDO no F2.22 (teto de 10x o limite, contando falhas)

- Teto de TENTATIVAS nas escritas: hoje so escrita ACEITA consome cota (M3.10,
  correto), mas tentativas que falham (400/404/502) nao contam em nada: uma
  chave valida pode martelar POST /v1/messages com chat_id arbitrario sem
  limite (custo e risco de throttle na conta-mestra; vetor de enumeracao
  residual apos o F2.13). Fix sugerido: segundo contador KV de tentativas
  (aceitas + falhas) com teto ~10x o limite diario, checado no middleware,
  fail-closed. Nao viola M3.10.
