# Acoes humanas (o que SO uma pessoa pode fazer para o projeto avancar)

Todo o codigo esta pronto e testado (174 testes verdes, review de seguranca
sem bloqueante). Este arquivo lista APENAS o que precisa de mao humana:
permissao em producao, contas externas, dados da empresa, juridico e gente de
verdade testando. Os comandos estao em [docs/go-live.md](docs/go-live.md).

Atualizado em 2026-09-10.

---

## 0. Colocar no ar

0.1 e 0.2 FEITOS em 2026-09-10 (go-live autorizado pelo Felipe): migrations
0008/0009 aplicadas e conferidas, Worker `291a684e`, landing `721dd6e6`,
smoke 7/7, e o push (0.5). Restam 0.3 e 0.4.

### 0.1 ~~Aplicar as migrations 0008 e 0009 no Supabase~~ FEITO
O modo de permissao do Claude bloqueou alteracao no banco de producao. Duas
opcoes:
- colar no SQL Editor do projeto `voojvcdihyymewrhrlti`, nesta ordem,
  [0008_pix_automatico.sql](supabase/migrations/0008_pix_automatico.sql) e
  [0009_portal.sql](supabase/migrations/0009_portal.sql) (as duas sao
  idempotentes: rodar de novo nao estraga nada); ou
- autorizar o Claude a rodar pelo Supabase CLI ja logado nesta maquina
  (comandos em go-live.md, secao H).

**Destrava:** o deploy do Worker. ATENCAO: deployar antes disto quebra o
checkout (a autorizacao do Pix e criada e cancelada em seguida).

### 0.2 ~~Deploy do Worker e publicacao da landing~~ FEITO
Depois de 0.1: `npm run deploy` neste repo e `bash publicar.sh` no repo da
landing. O Claude faz os dois se autorizado.

### 0.3 ~~Confirmar que o Pix Automatico esta habilitado no Asaas~~ FEITO
Conferido pela API em 2026-09-10: `GET /pix/automatic/authorizations` em
producao responde 200 (funcionalidade ativa na conta). As 2 autorizacoes que
ja existiam la sao testes do desenvolvimento do F2.18 (contratos `TESTE-...`),
ambas `CANCELLED`: nada cobrando, nada a fazer.

### 0.4 Uma compra de verdade, sua
Assine pela landing com o seu CPF (R$ 57), pague o QR, conecte um LinkedIn
seu pelo painel e gere a chave. E a unica prova ponta a ponta do fluxo novo
(checkout -> Pix -> webhook -> painel -> wizard -> chave). Depois cancele a
autorizacao no app do banco se quiser.

### 0.5 ~~Push dos commits para o GitHub~~ FEITO
Feito em 2026-09-10 com a conta `felipenunes07` do GitHub CLI (a conta ativa
da maquina e `BaseCoatMarketing`, sem acesso a esses repos; o push usou a
credencial certa so no comando, sem trocar a conta ativa).

---

## 1. Empresa e juridico (antes de mandar trafego pago)

- **Dados da empresa** em [termos.html] e [privacidade.html] no repo da
  landing: razao social, CNPJ, endereco, cidade do foro e nome do encarregado
  (DPO). Estao marcados em amarelo na pagina.
- **Revisao por advogado** dos termos e da politica (rascunhos completos,
  escritos para a LGPD e o CDC, mas nao revisados). Incluir na consulta o
  nome **"LinkedAPI"**: usa "Linked", e LinkedIn e marca registrada; ha risco
  de notificacao. Os textos ja dizem que a LinkedAPI nao e afiliada ao
  LinkedIn.
- **Caixa `contato@linkedapi.com.br`**: citada na landing, no painel e nos
  termos. Depende do dominio (item 2). Se preferir outro endereco, troque nos
  4 arquivos da landing.
- **Nota fiscal** da cobranca recorrente em BRL.

## 2. Dominio

- Registrar `linkedapi.com.br` (registro.br) e apontar como custom domain do
  Pages (site) e do Worker (API). O CORS ja aceita `linkedapi.com.br` e
  `www.linkedapi.com.br`.
- Depois: trocar `PORTAL_URL` no `wrangler.jsonc`, a URL do Worker em
  `js/main.js`, `js/painel.js`, `_headers` e nos links da landing, e o
  `server` do `openapi.json`.

## 3. E-mail transacional (opcional, recomendado)

Conta no Resend, dominio verificado, e no Worker:
`npx wrangler secret put RESEND_API_KEY` e `npx wrangler secret put EMAIL_FROM`.

**Destrava:** e-mail de boas-vindas com o link do painel e o "entrar no
painel" por e-mail. Sem isso o cliente entra pela sessao salva no navegador
em que pagou; se perder, o operador gera um link com
`npm run portal:link -- <tenant_id>`.

## 4. Gente de verdade (continua valendo)

- **Primeiro cliente real**: agora o onboarding e self-service, entao o
  primeiro cliente e a prova final das duas provas DEFERRED (pessoa externa
  conecta sozinha; pessoa nao-dev usa so chave + `/docs`). Roteiro de
  observacao em [docs/runbook-primeiro-cliente.md](docs/runbook-primeiro-cliente.md).
- **Reconectar a conta do Victor** (status CREDENTIALS na conta-mestra).
- **Dominio proprio na hosted auth** (config na Unipile): o wizard ainda
  mostra `account.unipile.com` na URL.

## 5. Negocio

- Definir os tiers de plano (hoje `basic` + override manual de limites).
- Revisar e fazer o merge do PR ja aberto:
  [vzbaggio/linkedapi-proxy#1](https://github.com/vzbaggio/linkedapi-proxy/pull/1)
  (branch `feat/marco4-fase2` do fork; cada push atualiza o PR).

---

## Ordem sugerida

0.1 -> 0.2 -> 0.3 -> 0.4 -> 1 -> 2 -> 3 -> 4 -> 5.

O que sobra depois disso esta em [docs/pendencias.md](docs/pendencias.md)
(divida tecnica consciente que nao bloqueia os primeiros clientes).
