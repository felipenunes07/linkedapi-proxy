# Runbook: primeiro cliente pagante

Desde o F2.20 o onboarding e SELF-SERVICE: o cliente assina na landing, paga o
Pix, conecta o LinkedIn e gera a chave pelo painel, sem operador. Este roteiro
e para OBSERVAR o primeiro cliente real, agir se algo travar e registrar as
evidencias das duas provas DEFERRED em 2026-09-02 (decisao no HANDOFF):
(a) pessoa EXTERNA conecta o proprio LinkedIn; (b) pessoa nao-dev opera a API
so com chave + `/docs`.

Operador: Felipe. Pre-requisito: go-live.md secao H concluida (migrations
0008/0009, deploy do Worker e landing publicada).

## 0. Pre-checks (1 min, read-only)

```bash
curl -s https://linkedapi-proxy.victor-58a.workers.dev/health
```

Espera `{"ok":true}`. Capacidade de seats (precisa de vaga livre):

```bash
curl -s https://linkedapi-proxy.victor-58a.workers.dev/admin/capacity -H "X-ADMIN-KEY: <ADMIN_API_KEY do .dev.vars>"
```

## 1. O cliente assina (sozinho)

Mande o link da landing (secao "Preco"). O checkout cria o tenant, o cliente
no Asaas e a autorizacao do Pix Automatico, e ja abre o QR. A mesma tela avisa
quando o Pix cai e leva ao painel.

Conferir:

```bash
npm run tenant:list
```

Tenant novo com assinatura `pending`; depois do Pix, `active` (webhook do
Asaas -> `/hooks/billing`).

## 2. O cliente conecta o LinkedIn (PROVA DEFERRED a)

No painel, "Conectar meu LinkedIn" gera o link do wizard (uso unico, 2h) e o
wizard devolve o cliente ao painel. Regras do operador:
- NUNCA abrir o link do cliente voce mesmo (foi assim que nasceu a conexao
  duplicada de 2026-09-02).
- Nao conectar conta manualmente no painel da Unipile enquanto houver token
  pendente (janela da ancora M4.11).
- "provider cannot accept more requests" no wizard: transitorio do LinkedIn;
  o cliente espera uns minutos e clica em conectar de novo (gera link novo).
- Quem entra no LinkedIn pelo Google precisa criar senha antes (o painel ja
  mostra essa dica).

Validacao forte (perfil e mesmo do cliente, nao um interno duplicado):

```bash
curl -s "https://<DSN da Unipile>/api/v1/accounts/<unipile_account_id>" -H "X-API-KEY: <UNIPILE_MASTER_TOKEN>"
```

Conferir `connection_params.im.publicIdentifier` = o perfil do cliente. No
Supabase, o `connect_token` mais novo do tenant deve estar `used`.

EVIDENCIA a registrar no HANDOFF: tenant_id, unipile_account_id, perfil
publico, horario, e a frase "vinculo automatico, zero toque manual".

## 3. O cliente gera a chave e integra (PROVA DEFERRED b)

No painel, "Gerar minha chave" mostra a `lk_live_` uma vez, com o exemplo de
curl e o link da documentacao. Nao ajude verbalmente.

Criterio de PASS: o cliente lista chats E envia uma mensagem sozinho, so com
chave + doc. Onde ele travar e onde a doc precisa melhorar (anotar!).

EVIDENCIA: horario do primeiro `200` real dele (`usage_daily` ou
`api_keys.last_used_at`) e o que ele conseguiu sozinho.

## 4. Se travar (planos B do operador)

| Situacao | Acao |
|---|---|
| Cliente fechou a aba e nao ha e-mail configurado | `npm run portal:link -- <tenant_id>` e mande o link por canal privado (uso unico, 72h) |
| Pix pago mas o painel segue "Aguardando" | `npm run billing:status`; conferir no Asaas se o webhook esta ativo e sem fila interrompida |
| Painel responde "sem vagas" | subir `SEAT_CAP` (se a conta-mestra tiver folga) ou liberar seat |
| Wizard falhou | o cliente clica em conectar de novo (ate 10 links por dia); ultimo recurso: `npm run connect:link -- <tenant_id>` |
| Chave vazou | o cliente gera outra no painel (a antiga para na hora); operador: `npm run key:revoke -- <key_id>` |
| Link ou painel vazou | o cliente usa "Sair de todos os dispositivos" no painel |

## 5. Fechamento

- Atualizar HANDOFF.md: marcar as provas a e b como CONCLUIDAS com as
  evidencias, e o Marco 4 como FECHADO.
- Observar por 48h: `/admin/usage`, `/admin/capacity` e os logs do Worker no
  dashboard Cloudflare (sinais `connect_*`, `portal_*`, `checkout_*`).
