# Decisoes tecnicas (log)

Registro curto das decisoes ja tomadas e do porque, para ninguem reabrir sem
motivo. Detalhe completo em @PRD.md secao 3 e 5.

| # | Decisao | Porque | Status |
|---|---|---|---|
| D1 | `account_id` resolvido server-side, nunca do request | Sem isso, cliente A age como B. Regra de seguranca #1. | Firme |
| D2 | Master token e DSN so no servidor, nunca em cliente/log | Vazamento compromete o negocio inteiro. | Firme |
| D3 | Guardar so o hash da API key | Reduz dano de vazamento do banco. | Firme |
| D4 | Rate limiting ja na V1 | Enviar msg/convite restringe contas no LinkedIn. | Firme |
| D5 | Uma unica conta-mestra Unipile, sem sharding | Custo por slot e plano; risco de suspensao age no dono da conta. | Firme (nao acoplar de forma que impeca segmentar depois) |
| D6 | Escopo so LinkedIn, so 3 endpoints na V1 | Provar o nucleo, nao espelhar 500+ endpoints. | Firme |
| D7 | Sem Recruiter/Jobs/Ads | Recruiter e origem de problemas de sessao/reconexao. | Firme |
| D8 | Sem n8n em nenhum caminho | Nao serve para API publica sincrona; falha sob rajada. | Firme |
| D9 | Cloudflare Workers + Hono para o proxy | Sincrono, baixa latencia, global, barato. | Firme (Vercel Functions e alternativa aceitavel) |
| D10 | Supabase (Postgres + RLS) | Isolamento de tenant no banco. | Firme |

## Marco 1 (proxy esqueleto) - decisoes e aprendizados

| # | Decisao | Porque | Status |
|---|---|---|---|
| M1.1 | No Marco 1, a NOSSA API key e uma chave fixa (`DEV_API_KEY`), nao o banco | Banco so entra no Marco 2. A forma da funcao (`resolveTenant`) ja e a final: key -> tenant -> account_id. | Temporario (Marco 2 troca por hash em `api_keys`) |
| M1.2 | Fallback embutido da chave (`dev-linkedapi-key`) so vale fora de producao | Evita fail-open: sem `DEV_API_KEY` setada em producao, ninguem entra, em vez de aceitar a constante publica. Achado do `security-reviewer`. | Firme |
| M1.3 | Comparacao da API key em tempo constante (hash SHA-256 dos dois lados) | Nao vazar a chave por timing nem por tamanho. | Firme |
| M1.4 | Envio de mensagem: `POST /api/v1/chats/{chat_id}/messages`, multipart, campo `text` | Confirmado na doc da Unipile. O `account_id` e campo opcional que serve de guard (impede enviar em chat de outra conta): injetamos sempre o do tenant. | Firme |
| M1.5 | O `account_id` do corpo do request e IGNORADO (nao rejeitado com erro) | O handler le so `chat_id` e `text`; qualquer `account_id` no corpo nunca chega a Unipile. Coberto por teste. | Firme |
| M1.6 | Erro da Unipile normalizado: `{ error, upstream_status, detail }`, sempre 502 | Nao repassar corpo cru nem status 5xx da infra ao cliente. `safeUpstreamError` filtra so `type/title/detail`. | Firme (revisar sanitizacao de `detail` no futuro) |

### Fatos de teste (dev)
- Alvo padrao de teste real, `chat_id` da Unipile e chaves de teste NAO ficam
  aqui (arquivo versionado). Vivem no `.dev.vars` (gitignored) e nas memorias
  do projeto. Nunca commitar valor de chave nem PII neste doc.
- Teste real do Marco 1: envio retornou 200 + `message_id`, sem segredo em log.

## Marco 2 (dados + isolamento) - decisoes e aprendizados

| # | Decisao | Porque | Status |
|---|---|---|---|
| M2.1 | Banco no Supabase `linkedapi-proxy` (projeto `voojvcdihyymewrhrlti`, sa-east-1) | Regiao SP = baixa latencia BR (D9). `Linkedin HQ` antigo estava pausado ha +90 dias e nao pode ser restaurado. | Firme |
| M2.2 | Worker fala com o banco so via PostgREST + SERVICE ROLE key | Simples (2 lookups), sem SDK pesado. Service role contorna RLS: por isso o codigo filtra por tenant_id na mao. | Firme |
| M2.3 | RLS ligada + zero policy permissiva + `revoke all from anon, authenticated` | Deny total para papeis publicos. Advisor marca "RLS enabled no policy" (INFO), que aqui e a estrategia, nao um bug. | Firme |
| M2.4 | `resolveTenant`: key -> hash SHA-256 -> `api_keys` (ativo) -> `tenant_id` -> `connected_accounts` (linkedin, ativo) -> `unipile_account_id` | Cadeia unica e server-side do account_id. Filtro por tenant_id explicito na 2a query (defesa em profundidade). | Firme |
| M2.5 | Hash da API key: SHA-256 puro (chave de alta entropia) | Chave e aleatoria/alta entropia, entao SHA-256 basta. Se um dia baixar a entropia, trocar por HMAC com salt. | Firme (revisar em Marco 5) |
| M2.6 | Erro upstream ao cliente: so `{ error, upstream_status }`, sem `detail` | `detail`/corpo da Unipile pode carregar DSN/host/account_id da conta-mestra. Endurecimento pos security-reviewer (era M1.6). | Firme |

### Follow-ups conscientes do Marco 2 (nao bloqueiam, resolver antes de clientes reais)
- ~~Rate limit ainda no-op~~ RESOLVIDO no Marco 3 (M3.4/M3.5). Escrita agora passa pelo contador.
- ~~`tenants.status` nao e checado na resolucao~~ RESOLVIDO no Marco 3 (M3.6).
- Posse do `chat_id`: o isolamento de conversa depende de a Unipile rejeitar `chat_id` de outra conta (guard via account_id). Confirmar com teste de integracao real.
- Resposta de sucesso repassa o corpo da Unipile (`data`); projetar so os campos da nossa API (ex.: `message_id`). Vale tambem para `/chats` e `/invitations` (Marco 3 manteve o repasse por consistencia).

## Marco 3 (3 endpoints + rate limit) - decisoes e aprendizados

| # | Decisao | Porque | Status |
|---|---|---|---|
| M3.1 | 3 endpoints V1: `POST /v1/messages`, `POST /v1/invitations`, `GET /v1/chats` | Escopo fechado da V1 (D6). Todos resolvem `account_id` server-side. | Firme |
| M3.2 | Convite: `POST /api/v1/users/invite` (JSON), campos `provider_id` + `account_id` + `message?` | Confirmado na doc da Unipile (invite-users). `account_id` sempre do tenant; `provider_id` vem do cliente (destinatario). | Firme |
| M3.3 | Listar chats: `GET /api/v1/chats?account_id=...&limit&cursor` | Filtro por `account_id` server-side isola os chats do tenant. Repassamos so paginacao do cliente. | Firme |
| M3.4 | Rate limit backend = Cloudflare KV (nao Upstash) | Nativo do Worker, zero dependencia externa, suficiente para limites diarios conservadores. Contrapartida: sem INCR atomico, leve overshoot sob concorrencia (aceitavel na V1). | Firme (trocar por Upstash se precisar contagem exata) |
| M3.5 | Limites default por tenant/dia (UTC): mensagens **80/dia**, convites **30/dia** | Partindo dos recomendados pela Unipile (convites 80-100/dia e ~200/semana; mensagens ~100/dia). Ficamos abaixo de proposito: 30 convites/dia respeita tambem o teto semanal (~210 vs 200), 80 msgs deixa margem. | Firme (revisar por conta/plano) |
| M3.6 | Estouro: 429 + header `Retry-After` (segundos ate a proxima meia-noite UTC), antes de chamar a Unipile | Cliente sabe quando tentar de novo; a acao restritiva nunca chega ao LinkedIn. | Firme |
| M3.7 | Sem binding de KV = 500 (`rate_limit_unavailable`), nao fail-open | Regra #4: nao escrever na Unipile sem protecao ativa. Misconfiguracao falha alto. | Firme |
| M3.8 | Rate limit so nas escritas (messages, invitations); `GET /chats` sem limite | Sao as acoes que restringem contas no LinkedIn. Leitura nao. | Firme |
| M3.9 | `resolveTenant` checa `tenants.status = active` (query extra) antes de `connected_accounts` | Suspender um tenant passa a ter efeito imediato, sem mexer conta a conta. Resolve follow-up do Marco 2. | Firme |
| M3.10 | Cota so incrementa em escrita ACEITA pela Unipile (`recordUsage` no handler), nao no middleware | O middleware so checa (429 se estourou, antes da Unipile). Contar antes da validacao deixava um 400/502 consumir cota (auto-DoS da propria cota com corpos invalidos). Achado do `security-reviewer`. | Firme |

### Fatos de teste real (Marco 3, conta de teste)
- Os 3 endpoints rodaram de ponta a ponta pelo Worker local contra a conta real
  (tenant A -> `yHCreubMTFeaqS2TqK1k2A`), auth por `X-API-KEY` (hash em `api_keys`):
  - `GET /v1/chats`: 200, todos os chats com `account_id` da conta do tenant (resolucao server-side ok).
  - `POST /v1/messages` (alvo Arthur): 200, `message_id` retornado.
  - `POST /v1/invitations` (alvo Mark Tomlet, sem nota): 200, `invitation_id` retornado.
- Isolamento (borda real): `POST /v1/messages` com `chat_id` fora da conta -> Unipile 404 -> proxy responde `{error, upstream_status:404}` em 502, sem vazar corpo. O guard `account_id` server-side barra chats arbitrarios.
- Caveat: o tenant B de teste aponta para uma conta placeholder (`acct-B-placeholder-nao-conectada`), nao um LinkedIn real. Por isso o teste cross-account com um `chat_id` real "do outro tenant" nao foi possivel no real; o isolamento cross-tenant continua provado pelos testes mockados (`test/isolation.test.ts`). Fechar com uma 2a conta real quando houver.
- Chave/valores em claro e PII do teste NAO ficam aqui (arquivo versionado). Vivem no `.dev.vars` e nas memorias do projeto.

## Endurecimento pre-clientes (2026-08-20)

| # | Decisao | Porque | Status |
|---|---|---|---|
| E1 | Respostas de sucesso projetadas por WHITELIST (`src/lib/sanitize.ts`): messages -> `{message_id}`, invitations -> `{invitation_id}`, chats -> `{items[ChatSummary], cursor}` | O corpo cru da Unipile expunha o `unipile_account_id` do tenant e permitia fingerprinting do provedor. Campo desconhecido nunca passa. Resolve o follow-up do Marco 2. | Firme |
| E2 | Scalar pinado (`@scalar/api-reference@1.65.1`) com SRI sha384 + crossorigin em /docs | /docs e onde o cliente cola a propria chave no playground; CDN comprometido nao pode virar script arbitrario. Ao atualizar a versao, recalcular o hash do arquivo exato. | Firme |
| E3 | Migration 0002: unique em `connected_accounts.unipile_account_id` + CHECK nas colunas `status` das 3 tabelas | O banco garante sozinho que uma conta nunca aponta para dois tenants (pre-requisito do callback do Marco 4) e que typo nao cria estado invalido silencioso. | Firme |
| E4 | Exemplo do 429 no openapi.json agora bate com o schema (ErrorEnvelope ganhou `action`/`limit`/`retry_after` opcionais) e cada 200 tem schema proprio | Doc publicada nao pode divergir do que a API responde. | Firme |

## Marco 4 (auto-conexao) - decisoes e aprendizados

| # | Decisao | Porque | Status |
|---|---|---|---|
| M4.1 | Link de hosted auth gerado por script do operador (`connect:link` / `connect:reconnect`), nao por rota autenticada | Superficie minima: nenhuma rota nova atras de chave (um tenant novo nem teria como autenticar: `resolveTenant` exige conta conectada). Self-service fica para a fase 2. | Firme (rever na fase 2) |
| M4.2 | Correlacao por token opaco de uso unico no campo `name` do link; so o hash vai ao banco (`connect_tokens`, migration 0003); consumo por UPDATE condicional (pending -> used) ANTES de qualquer escrita | O notify NAO tem assinatura documentada; `name` e o mecanismo oficial de correlacao. Consumo atomico mata replay e corrida (achado do security-reviewer); token queimado em fluxo que falha depois e o comportamento seguro. 256 bits, validade 2h, `single_use: true`. | Firme |
| M4.3 | Verificacao upstream com correlacao forte: `GET /accounts/{id}` precisa devolver tipo LINKEDIN e, no create, `name` IGUAL ao token; reconnect SO reativa a conta que o tenant ja tem; purpose do token amarrado ao status do notify | So `type === LINKEDIN` nao amarrava o account_id ao token: um notify forjado com token valido podia vincular conta alheia da conta-mestra (achado BLOQUEANTE do security-reviewer). Falha fechado; confirmar o campo `name` no primeiro teste real. | Firme |
| M4.4 | Conflito cross-tenant: resposta 200 GENERICA (sem oraculo) + `console.error` so com o uuid do token; mesmo tenant: idempotente, reativa; conta `paused` NUNCA reativa por conexao/reconexao | Nunca re-vincular conta entre tenants; o unique do banco (E3) cobre corrida. 409 distinto vazava "essa conta existe e e de outro" a quem tem token. Pausa e decisao de negocio (inadimplencia), o wizard nao desfaz. | Firme |
| M4.5 | `disabled_features`: `linkedin_recruiter`, `linkedin_sales_navigator`, `linkedin_organizations_mailboxes` | D7. A doc da hosted auth nao tem toggle especifico de "Jobs"; Recruiter/Sales Nav cobrem o caso real. | Firme |
| M4.6 | Path do callback neutro (`/hooks/connect`) e fora do `openapi.json` | Regra de ouro do Marco 5: nenhuma superficie publica cita o vendor. | Firme |
| M4.7 | Throttle no callback (KV, fail-closed): 5 tentativas/dia por token, 100/dia por IP, teto de 200 chars no `name`; sem KV, 500 | Rota publica que escreve no banco nao opera sem teto: cada tentativa custa query com service role e, com token valido, chamada a Unipile. Mesma postura fail-closed da regra #4. | Firme |
| M4.8 | 1 seat = 1 conta: vincular conta nova desativa as demais ativas do tenant; `resolveTenant` ordena `created_at.desc` | Sem isso um segundo connect:link acumulava contas ativas e a chave do tenant agia por uma linha nao deterministica (PostgREST sem order). | Firme |
| M4.9 | `app.onError` responde `{error: internal_error}` 500 e loga so `name: message` | Throw nao tratado caia no default do Hono (texto fora do ErrorEnvelope, log do objeto cru). Mensagens internas sao codigos sem segredo. | Firme |
| M4.10 | `PUBLIC_BASE_URL` exige `https://` no script | O notify carrega o token em claro no corpo; nunca por http. | Firme |
| M4.11 | Ancora do create: igualdade de `name` OU conta criada DEPOIS do token (created_at, folga 60s) | Confirmado no real (2026-09-02): a Unipile renomeia a conta para o nome do perfil, o token nao persiste no `name` da conta; a igualdade pura rejeitava todo fluxo legitimo (token queimado, conta orfa, vinculo manual pelo operador). Conta pre-existente segue impossivel de vincular: created_at antigo falha na ancora temporal. Data ausente/malformada falha fechado (401). | Firme |

## Fase 2 (billing, webhooks, planos, admin) - decisoes

Spec completa em specs/fase-2.md.

| # | Decisao | Porque | Status |
|---|---|---|---|
| F2.1 | Limites por tenant no banco (overrides NULLaveis, CHECK 1..1000), resolvidos junto com o tenant; defaults em src/lib/limits.ts | Vender tier vira UPDATE, sem deploy. O limite continua 100% server-side. | Firme |
| F2.2 | Uso persistente em usage_daily via RPC atomica increment_usage + api_keys.last_used_at, SEMPRE best-effort pos-resposta (fireAndForget/waitUntil) | KV expira em 2 dias e nao fatura. Telemetria nunca atrasa nem derruba request; o rate limit continua no KV. | Firme |
| F2.3 | Self-service atras do auth: POST /v1/keys/rotate (revoga SO a chave usada, cria antes de revogar) e PUT/GET/DELETE /v1/webhook | Autonomia minima do cliente sem operador. Falha na criacao nunca deixa o tenant sem chave; GET nunca reexibe secret. | Firme |
| F2.4 | Webhook do cliente assinado com HMAC-SHA256 estilo timestamp.corpo (X-Webhook-Signature/Timestamp/Event), 3 tentativas em waitUntil | Cliente valida origem e rejeita replay. Fila duravel (Queues) fica para depois (pendencias). | Firme |
| F2.5 | EXCECAO consciente a regra "so hash": tenants.webhook_secret fica recuperavel | Precisa assinar cada evento. Mitigacao: gerado por nos (256 bits), nunca escolhido pelo cliente, tabela service-role-only, reexibido nunca. | Firme (unico segredo recuperavel do banco) |
| F2.6 | Hooks de evento publicos com secret compartilhado em header, comparado por hash (secretsEqual) e FAIL-CLOSED (sem secret no env = 500) | Mesma postura da regra #4: rota que escreve nao opera sem protecao. Comparacao timing-safe. | Firme |
| F2.7 | /hooks/account-status: sessao caida -> disconnected + evento account.disconnected com link de reconexao AUTO-GERADO (mesmo desenho do Marco 4, 24h); volta -> active; paused INTOCAVEL por status de sessao; updates filtram o status atual | Reconexao era o maior centro de custo de suporte previsto no PRD. Pausa e decisao de billing, nao de sessao. Filtro de status = idempotencia sob retry do webhook. | Firme |
| F2.8 | /hooks/message-received: tenant resolvido pela conta NO BANCO, payload projetado por whitelist antes de repassar | Nunca confiar em payload para decidir tenant; account_id e campos internos da origem nao chegam ao cliente (white-label tambem nos eventos). | Firme |
| F2.9 | Billing Asaas: assinatura Pix mensal criada por script do operador; o Worker so processa o webhook. PAYMENT_OVERDUE pausa as contas ativas do tenant; CONFIRMED/RECEIVED despausa | Regra do PRD: pausar, nunca deletar. Credencial do Asaas nao vive no Worker. Assinatura resolvida por billing_subscriptions, nunca pelo payload. | Firme |
| F2.10 | API admin read-only atras de X-ADMIN-KEY (hash-compare); sem ADMIN_API_KEY as rotas respondem 404 | Operacao precisa de visao (tenants, uso, capacidade de seats) sem UI ainda. Superficie desligada nem aparece. | Firme |
| F2.11 | Capacidade de seats: /admin/capacity cruza contas ativas no banco com a lista da conta-mestra e o teto SEAT_CAP (default 10); origem fora do ar = `master_unavailable: true` e `seats_available: null`, nunca zero fingido | O fracionamento do piso de ~10 contas E a economia do negocio; agora tem medidor, e o medidor nao mente. | Firme |
| F2.12 | Endurecimento pos-review da fase 2: (a) hooks de evento com throttle KV fail-closed (por IP e por conta/assinatura, lib compartilhada com /hooks/connect); (b) derrubada de conta confirma o status na origem antes (payload OK na origem = ignora); (c) falha na geracao do link de reconexao NUNCA engole a notificacao de queda; (d) TTL do link automatico igual ao do operador (2h); (e) URL de webhook do cliente validada (so https:443, sem credencial, sem IP literal/localhost/.internal) e entrega com redirect:manual + timeout 5s (anti-SSRF); (f) CHECK dos overrides de limite no teto SEGURO do provedor (150 msgs, 100 convites); (g) touch de last_used_at deduplicado por KV (1/h) e filtrado por tenant; (h) unipileFetch nunca deixa o DSN vazar em erro de runtime (upstream_unreachable); (i) Cache-Control no-store nas respostas que carregam segredo; (j) tenant suspenso/conta pausada nao recebem eventos | Achados I1-I5 e M1/M2/M3/M5/M7/M8 do security-reviewer. Nenhum era bloqueante; todos corrigidos antes do PR. | Firme |
| F2.13 | Erro upstream por semantica de recurso: /messages mapeia upstream 403/404 para `404 {error: not_found}` unico (sem upstream_status); /invitations so 404 -> not_found (403 do provider segue upstream_error); /chats sem mapeamento | O teste real de isolamento (2026-09-01) mostrou chat de outro tenant virando `502 upstream_error` com `upstream_status: 403`: semantica errada e um oraculo fraco (separava "nao e seu" de "nao existe"). 404 unico nao distingue os dois casos. Cota segue nao consumida nesses caminhos. | Firme |

| F2.14 | Checkout proprio (`POST /checkout`, publico) no lugar do Link de Pagamento hospedado: o cliente informa nome/e-mail/documento na nossa pagina e recebe o QR do Pix ali mesmo. Camadas: content-type `application/json` obrigatorio + recusa de Origin fora da allowlist (CORS sozinho NAO impede escrita cross-site: um POST `text/plain` e simple request e nao dispara preflight); throttle por IP, GLOBAL e por documento hasheado; modulo 11 de CPF/CNPJ antes de tocar o Asaas; lock de idempotencia por e-mail+documento; checagem de seat livre; ordem cliente -> tenant -> assinatura -> vinculo, com CANCELAMENTO da assinatura se o vinculo falhar; cliente criado com notificacao do Asaas DESLIGADA | O checkout hospedado mostrava a razao social da conta (empresa que o comprador nao reconhece), sem logo e sem Pix: cara de golpe na hora de pagar. Os tres bloqueantes do security review estao endereçados: B1 (CSRF cross-site criando cobranca no IP de terceiros), B2 (cobranca por e-mail contra CPF de terceiro saindo da nossa conta) e B3 (cliente cobrado sem vinculo, irrecuperavel pelo webhook). A `ASAAS_API_KEY` passa a viver no Worker: mesmo nivel de confianca da service role do Supabase que ja estava la. | Firme |
| F2.15 | O Asaas EXIGE header `User-Agent` (erro `user_agent_not_informed`) e o fetch do Workers nao manda um por padrao; `ASAAS_BASE_URL` configuravel no Worker | Descoberto no primeiro teste real: toda chamada do Worker ao Asaas voltava 400 e virava "documento invalido" para o cliente. Sem o override de base, `npm run dev` criaria cobranca REAL em producao. | Firme |

| F2.16 | Cliente que paga por PIX passa a receber os avisos do Asaas (religados em `PAYMENT_CONFIRMED`); cartao NAO religa | Assinatura Pix nao debita sozinha: sem o aviso mensal o cliente nao paga o mes 2 e a conta pausa. Cartao debita sozinho, e religar ali reabriria o B2 (cobranca por e-mail contra o endereco que o pagador digitou) de forma automatica. Metodo desconhecido nao religa. | Firme |
| F2.17 | Checkout aceita CARTAO (cobranca automatica real) alem de Pix, em "checkout transparente": o dado do cartao atravessa o Worker e vai direto ao Asaas, nunca gravado nem logado. Camadas exigidas pelo review: no caminho PCI so o CODIGO de erro do upstream e logado (texto livre de terceiro nunca, nem higienizado); `validationDetail` redige sequencias de 12+ digitos; ultimos digitos e bandeira truncados e validados antes de sair; Luhn e validade futura conferidos localmente; tetos de tamanho antes de qualquer regex; `remoteIp` omitido quando desconhecido (mandar literal invalido desligaria o antifraude em silencio); contador de RECUSAS por IP (3/dia) contra card testing; teto por IP checado ANTES de tocar o contador global (senao um IP abusivo derrubava as vendas do dia); lock liberado em toda saida de falha (senao recusa prendia o cliente por 15 min justamente quando ele quer tentar outro cartao); tenant orfao removido na recusa; `tenantId` logado na falha indeterminada (unico fio de reconciliacao quando o dinheiro pode ter saido) | O dono do negocio assumiu conscientemente o escopo PCI DSS para ter recorrencia automatica com a marca propria. Pix segue disponivel como alternativa sem cartao. | Firme |

| F2.18 | Cartao SAI do nosso formulario; o checkout proprio passa a usar PIX AUTOMATICO (autorizacao unica no QR, o Asaas debita sozinho nos ciclos seguintes). Quem quiser cartao vai para um link hospedado pelo Asaas | A doc do Asaas e explicita: eles NAO oferecem tokenizacao no navegador e recomendam SAQ-D para quem digita cartao em pagina propria; a certificacao PCI deles "nao certifica automaticamente os sistemas da empresa que integra". Pix nao e cartao, entao o Pix Automatico entrega as tres coisas ao mesmo tempo: cobranca automatica, nossa marca na tela e zero escopo PCI. O F2.17 (cartao no nosso form) foi revertido por isso. | Firme |
| F2.19 | `/hooks/billing` resolve o tenant por assinatura OU por cliente, e grava o `asaas_subscription_id` na primeira vez que ele aparece | No Pix Automatico a assinatura so nasce depois que o pagador autoriza no banco dele, entao a primeira cobranca pode chegar sem `subscription`. O `customer` sempre vem e sempre foi gravado por nos. Os dois campos vem do NOSSO banco; o payload so fornece a chave de busca, nunca a identidade do tenant. | Firme |

## Em aberto (ver PRD secao 12)
- Registrar o dominio da API (`linkedapi.com.br`); nome LinkedAPI ja em uso nos docs.
- ~~Valores default do rate limiter~~ RESOLVIDO no Marco 3 (M3.5: 80 msgs/dia, 30 convites/dia).
- ~~Provedor de rate limit: KV vs Upstash~~ RESOLVIDO no Marco 3 (M3.4: Cloudflare KV).
- ~~Infra do banco: projeto Supabase sumiu do DNS~~ RESOLVIDO em 2026-09-01: o
  Victor restaurou o `voojvcdihyymewrhrlti` (mesma URL/key) e o bootstrap.sql
  foi aplicado; provas reais executadas (ver HANDOFF).
