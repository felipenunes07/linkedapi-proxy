# Runbook: primeiro cliente pagante

Roteiro unico, em ordem, do onboarding do PRIMEIRO cliente real. Ele tambem e
a evidencia final das duas provas DEFERRED em 2026-09-02 (decisao registrada
no HANDOFF): (a) pessoa EXTERNA conecta o proprio LinkedIn pelo link; (b)
pessoa nao-dev opera a API so com chave + `/docs`.

Operador: Felipe. Duracao estimada: 30 min de operador + o tempo do cliente.

## 0. Pre-checks (1 min, read-only)

```bash
curl -s https://linkedapi-proxy.victor-58a.workers.dev/health
```

Espera `{"ok":true}`. Capacidade de seats (precisa de vaga livre):

```bash
curl -s https://linkedapi-proxy.victor-58a.workers.dev/admin/capacity -H "X-ADMIN-KEY: <ADMIN_API_KEY do .dev.vars>"
```

## 1. Criar o tenant do cliente

```bash
npm run tenant:create -- "<Nome do cliente>"
```

Anotar o `tenant_id`.

## 2. Link de conexao (PROVA DEFERRED a: pessoa externa)

```bash
npm run connect:link -- <tenant_id>
```

Enviar o link ao cliente com estas instrucoes (copiar junto):

> Abre este link NO SEU celular ou computador e conecta o SEU LinkedIn
> (e-mail e senha da sua conta). Se voce entra no LinkedIn pelo Google e nao
> tem senha: antes, va em linkedin.com > "Esqueceu a senha?" > crie uma com
> seu e-mail, e use ela no link. Leva 2 minutos, nao instala nada. O link
> vale por 2 horas e funciona uma vez so.

Regras do operador:
- NUNCA abrir o link voce mesmo (foi assim que nasceu a conexao duplicada de
  2026-09-02).
- Nao conectar conta manualmente no painel da Unipile enquanto houver token
  pendente (janela da ancora M4.11).
- Se o wizard der "provider cannot accept more requests": transitorio do
  LinkedIn; esperar uns minutos e gerar um LINK NOVO (o antigo queima).
- Link expirou antes do cliente usar: gerar outro, sem custo.

## 3. Validar o vinculo automatico (fecha a prova a)

Quando o cliente disser que concluiu:

```bash
npm run tenant:list
```

Conferir: conta nova no tenant certo, status `active`. Validacao forte
(perfil e MESMO do cliente, e nao um interno duplicado):

```bash
curl -s "https://<DSN da Unipile>/api/v1/accounts/<unipile_account_id>" -H "X-API-KEY: <UNIPILE_MASTER_TOKEN>"
```

Conferir `connection_params.im.publicIdentifier` = o perfil do cliente.
No Supabase, o `connect_token` mais novo do tenant deve estar `used`.

EVIDENCIA a registrar no HANDOFF: tenant_id, unipile_account_id, perfil
publico, horario, e a frase "vinculo automatico, zero toque manual".

## 4. Emitir a chave

```bash
npm run key:issue -- <tenant_id>
```

Guardar o `key_id` (para revogar se precisar). A chave `lk_live_...` vai
para o cliente por canal seguro, uma vez so.

## 5. Teste nao-dev (PROVA DEFERRED b)

Enviar ao cliente SOMENTE isto (sem ajuda verbal, sem mencionar Unipile):

> Sua chave de API: lk_live_...
> Documentacao: https://linkedapi-proxy.victor-58a.workers.dev/docs
> Autentique com o header X-API-KEY. Experimente listar suas conversas e
> enviar uma mensagem.

Criterio de PASS: o cliente lista chats E envia uma mensagem sozinho, so com
chave + doc. Onde ele travar e onde a doc precisa melhorar (anotar!).

EVIDENCIA a registrar: o que o cliente conseguiu sozinho, onde travou,
horario do primeiro `200` real dele (conferir em `usage_daily` ou
`api_keys.last_used_at`).

## 6. Cobranca (Asaas)

Pre-requisito: secao "Asaas sandbox" abaixo ja validada uma vez.

```bash
npm run billing:subscribe -- <tenant_id> "<Nome>" <cpf_cnpj> <email>
```

Cria cliente + assinatura Pix mensal (R$57, `PLAN_PRICE_BRL` para mudar).
Inadimplencia pausa a conta sozinha via webhook; pagamento despausa.

```bash
npm run billing:status
```

## 7. Fechamento

- Atualizar HANDOFF.md: marcar as provas a e b como CONCLUIDAS com as
  evidencias, e o Marco 4 como FECHADO.
- `npm run webhook:register` ja foi executado (account-status e messaging
  registrados em 2026-09-01/02); nada a fazer.
- Observar por 48h: `/admin/usage`, `/admin/capacity` e os logs do Worker no
  dashboard Cloudflare (sinais `connect_*`).

---

## Anexo: Asaas sandbox (fazer UMA vez, antes do primeiro cliente)

1. Criar a conta sandbox: https://sandbox.asaas.com (cadastro gratis,
   independente da conta real).
2. No painel sandbox: gerar a API key (Integracoes > API).
3. No `.dev.vars`, adicionar:

```
ASAAS_API_KEY="<key do sandbox>"
ASAAS_BASE_URL="https://api-sandbox.asaas.com/v3"
```

4. No painel sandbox, configurar o webhook de cobranca:
   - URL: `https://linkedapi-proxy.victor-58a.workers.dev/hooks/billing`
   - Header `asaas-access-token`: o valor de `ASAAS_HOOK_TOKEN` do `.dev.vars`
     (ja esta subido como secret no Worker).
   - Eventos: pagamentos (confirmado, recebido, vencido).
5. Testar com um tenant de teste:

```bash
npm run billing:subscribe -- <tenant_id_teste> "Cliente Sandbox" 12345678909 teste@example.com
```

6. No painel sandbox, simular pagamento confirmado e depois vencido;
   conferir que `connected_accounts.status` do tenant pausa no vencido e
   despausa no pago (`npm run tenant:list`).
7. Producao: criar a conta real no https://www.asaas.com, repetir os passos
   2-4 com a key real e `ASAAS_BASE_URL` removido do `.dev.vars` (o default
   ja e producao), e subir a key real: `npx wrangler secret put ASAAS_API_KEY`
   NAO e necessario (a key so e usada pelos scripts do operador, nao pelo
   Worker; o Worker so precisa do ASAAS_HOOK_TOKEN, ja em producao).
