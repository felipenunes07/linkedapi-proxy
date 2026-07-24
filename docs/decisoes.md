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
- Rate limit ainda no-op (Marco 3): `POST /v1/messages` ja escreve na Unipile sem throttle. Regra inviolavel #4.
- `tenants.status` nao e checado na resolucao: suspender um tenant hoje so tem efeito via `connected_accounts.status`. Adicionar filtro por status do tenant.
- Posse do `chat_id`: o isolamento de conversa depende de a Unipile rejeitar `chat_id` de outra conta (guard via account_id). Confirmar com teste de integracao real.
- Resposta de sucesso repassa o corpo da Unipile (`data`); projetar so os campos da nossa API (ex.: `message_id`).

## Em aberto (ver PRD secao 12)
- Nome/marca do produto e dominio da API.
- Valores default do rate limiter (partir dos recomendados pela Unipile).
- Provedor de rate limit: Cloudflare KV vs Upstash Redis (decidir no Marco 3).
