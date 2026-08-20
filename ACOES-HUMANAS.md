# Acoes humanas (o que SO uma pessoa pode fazer para o projeto avancar)

Todo o codigo esta pronto e testado (100 testes verdes). Este arquivo lista
APENAS o que precisa de mao humana: logins, contas externas, dinheiro,
assinatura de contrato e gente de verdade testando. Cada item diz quem faz,
como faz e o que destrava. O restante (comandos, seeds, provas automatizadas)
esta em [docs/go-live.md](docs/go-live.md) e ja e executavel.

Atualizado em 2026-08-20.

---

## 1. Victor (dono da infra) - BLOQUEIA TUDO

### 1.1 Restaurar o banco Supabase
O projeto `voojvcdihyymewrhrlti` (sa-east-1) sumiu do DNS (pausado por
inatividade ou deletado). Sem banco, nenhuma prova real roda.

- Entrar em https://supabase.com/dashboard com a conta do Victor.
- Se o projeto aparecer pausado: **Restore project**.
- Se nao der para restaurar: criar projeto novo, regiao `sa-east-1`.
- Colar o conteudo de [supabase/bootstrap.sql](supabase/bootstrap.sql) no
  **SQL Editor** e executar (uma vez so; e idempotente).
- Copiar e enviar para quem opera: **Project URL** e **service_role key**
  (Settings > API). Elas entram no `.dev.vars` local (nunca no git).

**Destrava:** prova real da chave (Marco 5), seeds de tenant, tudo do banco.

### 1.2 Login na Cloudflare para o deploy
O Worker nunca foi publicado; `wrangler` esta sem login nesta maquina.

- Na maquina do projeto, rodar:

```bash
npx wrangler login
```

- (abre o navegador; logar com a conta Cloudflare do Victor e autorizar)
- Depois disso o resto e comando pronto: `npm run deploy:setup` e
  `npm run deploy`.

**Destrava:** URL publica do Worker, e com ela a auto-conexao (Marco 4), os
webhooks e a doc publica `/docs` no ar.

### 1.3 Registrar o dominio
- Registrar `linkedapi.com.br` (registro.br) e apontar como custom domain do
  Worker no painel da Cloudflare. Sem pressa: a URL `*.workers.dev` cobre o
  interim. Depois, trocar o `server` do [openapi.json](openapi.json).

**Destrava:** marca propria na URL (hoje o placeholder da doc aponta para um
dominio que nao existe).

---

## 2. Operador (Felipe ou Victor) - contas e segredos externos

### 2.1 Conta no Asaas (billing)
O codigo de cobranca esta pronto; falta a conta.

- Criar/usar a conta Asaas da empresa (https://www.asaas.com).
- Gerar a **API key** (colocar em `ASAAS_API_KEY` no `.dev.vars`).
- No painel do Asaas, configurar o webhook de cobranca apontando para
  `https://<url-do-worker>/hooks/billing`, com um token forte no header
  `asaas-access-token` (o MESMO valor vai em `ASAAS_HOOK_TOKEN` no Worker).
- Validar primeiro no sandbox (`ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3`).

**Destrava:** cobrar de verdade: `npm run billing:subscribe` cria a assinatura
Pix; atraso pausa o cliente sozinho, pagamento despausa.

### 2.2 Gerar e subir os secrets da fase 2
Sao 4 valores novos que alguem precisa gerar (32 bytes hex) e subir em DOIS
lugares (`.dev.vars` local E `npx wrangler secret put <NOME>` em producao):
`ACCOUNT_STATUS_HOOK_SECRET`, `MESSAGE_HOOK_SECRET`, `ASAAS_HOOK_TOKEN`,
`ADMIN_API_KEY`. Gerar cada um com:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Destrava:** hooks de status/mensagem (reconexao automatizada e webhooks ao
cliente, apos `npm run webhook:register`) e a API `/admin`.

---

## 3. Gente de verdade (as provas que nao tem como automatizar)

### 3.1 Alguem de fora conectar o proprio LinkedIn
E o criterio de aceite do Marco 4: o operador roda `npm run connect:link`,
envia o link, e uma pessoa que NAO e da equipe conclui o wizard sozinha, sem
nunca ver a palavra Unipile. Conferir depois com `npm run tenant:list`.

**Tambem aproveitar para:** reconectar a conta do proprio Victor (esta com a
sessao caida na conta-mestra, status CREDENTIALS).

### 3.2 Uma pessoa nao-dev usar a API so com chave + doc
E a promessa literal da V1 (PRD secao 6): entregar a chave `lk_live_` e o link
do `/docs` e observar a pessoa enviar mensagem e convite sem ajuda verbal.
Onde ela travar, e ali que a doc precisa melhorar.

### 3.3 Uma segunda conta LinkedIn real para a prova de isolamento
A alegacao central do produto (chave A nunca age pela conta B) so esta provada
em testes com mocks. Precisa de 2 tenants com contas REAIS: rodar chave A com
um `chat_id` real do tenant B e confirmar que falha.

---

## 4. Negocio e juridico (decisao do dono)

- **Termos de uso + politica de privacidade + LGPD**: nada foi redigido. O
  produto guarda tokens de sessao e repassa conteudo de mensagens de
  terceiros; revisar com advogado antes de cliente pagante.
- **Nota fiscal / regularizacao** da cobranca recorrente em BRL (R$57/mes).
- **Definir os tiers de plano**: hoje existe `basic` + override manual de
  limites por tenant (teto seguro 150 msgs / 100 convites por dia). Decidir se
  havera plano maior e a que preco.
- **Abrir o pull request**: os commits estao locais; empurrar e revisar:

```bash
git checkout -b feat/marco4-fase2 && git push -u origin feat/marco4-fase2
```

---

## Ordem sugerida

1.1 banco -> 1.2 wrangler -> (go-live secoes A-E rodam em comandos) ->
2.2 secrets -> 2.1 Asaas -> 3.1/3.2/3.3 provas com gente -> 1.3 dominio -> 4.

Feito isso, o que sobra esta em [docs/pendencias.md](docs/pendencias.md)
(divida tecnica consciente que nao bloqueia os primeiros clientes).
