# Acoes humanas (o que SO uma pessoa pode fazer para o projeto avancar)

Todo o codigo esta pronto, testado (249 testes) e revisado. Este arquivo lista
APENAS o que precisa de mao humana. Os comandos de deploy estao em
[docs/go-live.md](docs/go-live.md) (secoes H e I).

Atualizado em 2026-09-13.

Onde fica cada coisa:
- Landing e painel: Vercel, https://app.playbooklab.com.br (deploy a
  cada push no `master` do repo da landing).
- Backend: Cloudflare Workers na conta do Victor,
  https://linkedapi-proxy.victor-58a.workers.dev (`npm run deploy`).
- Nome do produto: "Playbook API" e PROVISORIO. Contato publicado:
  victor@playbooklab.com.br.

---

## 0. Preco novo e assentos: NO AR em 2026-09-13

Feito, nada pendente aqui:

1. ~~Migration 0011~~ aplicada no Supabase (`tenants.group_id`,
   `connected_accounts.label` e o tipo de token `seat`, conferidos no banco).
2. ~~Deploy do Worker~~ feito (versao `00cb07dd`): preco R$ 67, assentos
   adicionais e a doc com a nossa marca. Smoke: `/health` ok, `/portal/seats`,
   `/portal/seat` e `/portal/switch` respondendo 401 sem sessao (existem),
   `/docs` com o header novo.
3. ~~Conferir `PLAN_PRICE_BRL`~~: a var NAO existe no Worker, entao vale o
   default do codigo (67). Se um dia ela for criada, ela ganha do codigo.
4. ~~Push da landing~~ feito; a Vercel publicou e a pagina mostra R$ 67.

Para o futuro: autorizacao de Pix Automatico ja assinada vale pelo valor
autorizado; subir o preco de quem ja paga exige nova autorizacao.

**Confirmar antes do primeiro onboarding real:** existe um secret
`UNIPILE_AUTH_HOST` no Worker (F2.30). Com ele preenchido, o link de conexao
sai NAQUELE dominio. Se o dominio ainda nao tem CNAME e certificado, a tela de
conexao do cliente nao abre. Confira o valor com quem o cadastrou e, se o
dominio nao estiver pronto, remova:

```bash
npx wrangler secret delete UNIPILE_AUTH_HOST
npm run deploy
```

## 1. Provar com dinheiro de verdade

- **Cadastrar o site na conta Asaas.** Minha Conta > Informacoes > Site:
  `https://app.playbooklab.com.br`, e clicar em Salvar no fim do formulario.
  Conferido pela API deles em 2026-09-13: o campo ainda volta vazio
  (`commercialInfo.site = null`), entao a edicao nao chegou a salvar. E dado
  cadastral; NAO e o que decide para onde o cliente volta depois de pagar
  (isso vem do nosso backend, que ja manda para o dominio proprio).
- **Uma compra no Pix e uma no cartao** (R$ 67 cada), com CPF e LinkedIn da
  equipe: checkout -> pagamento -> painel -> conectar LinkedIn -> gerar chave.
  E a unica prova ponta a ponta do fluxo inteiro. No cartao, conferir no mes
  seguinte que a renovacao continua ativando a conta. Depois, cancelar pelo
  app do banco (Pix) ou pedindo o cancelamento (cartao).
- **Um assento adicional** (F2.29), com a mesma conta: no painel, "Adicionar
  outra conta" -> mesmo checkout -> pagar -> conferir que a conta nova aparece
  na lista, que a PRIMEIRA continua ativa (a compra nova nao pode encerrar a
  anterior) e que da para alternar entre as duas. Se as duas forem Pix com o
  mesmo CPF, conferir tambem que o pagamento ativou o assento certo (o log
  marca `billing_ambiguous_customer` quando nao da para decidir).

## 1b. Dominio proprio da API (decisao de conta, nao de codigo)

O site e o painel ja atendem em `app.playbooklab.com.br`. A API e a
documentacao continuam em `linkedapi-proxy.victor-58a.workers.dev`, que e o
endereco que o cliente ve no `curl` e no botao Documentacao.

Tentado em 2026-09-13 e BLOQUEADO: o Worker vive na conta Cloudflare do Victor
(`58af046e...`) e a zona `playbooklab.com.br` esta em OUTRA conta Cloudflare.
O deploy recusa com `Can't infer zone from route`. Para ter
`api.playbooklab.com.br`, alguem precisa decidir uma destas:

1. mover a zona `playbooklab.com.br` para a conta do Victor (mexe no DNS do
   dominio inteiro da empresa: site, e-mail, tudo);
2. mover o Worker para a conta que tem a zona (contraria a decisao de
   2026-09-10 de manter o backend na conta do Victor);
3. deixar como esta: a API responde num endereco tecnico, e so.

Nao e bloqueio de venda: nada quebra hoje. E questao de aparencia na doc.

## 2. Empresa e juridico (antes de mandar trafego pago)

- **Dados da empresa** em `termos.html` e `privacidade.html` (repo da landing):
  razao social, CNPJ, endereco, cidade do foro e nome do encarregado (DPO).
  Estao marcados em amarelo.
- **Revisao por advogado** dos termos e da politica (rascunhos completos para
  LGPD e CDC, nao revisados).
- **Nota fiscal** da cobranca recorrente.
- **Nome definitivo** do produto (o atual e provisorio). Ao trocar, seguir a
  lista de arquivos no README da landing.

## 3. Tirar a marca da origem da tela de conexao (F2.30)

O codigo ja esta pronto: com a var `UNIPILE_AUTH_HOST` preenchida, o link que
o painel abre sai no NOSSO dominio. Sem ela, sai no dominio da origem (e
funciona igual). O que falta e so o que depende de voces:

1. **Registrar o dominio proprio** (ainda nao existe; hoje a landing e
   `landing-api-linkedin.vercel.app`, e em dominio da Vercel nao da para criar
   o CNAME abaixo). Este e o unico bloqueio real.
2. **Criar o CNAME** no painel do registrador:
   - Nome: `auth` (vira `auth.seudominio.com.br`)
   - Tipo: `CNAME`
   - Valor/alvo: `account.unipile.com.` (com o ponto no fim)
   - A propagacao leva ate 24h. Confira em whatsmydns.net antes do passo 3.
3. **Abrir chamado na Unipile** (chat do dashboard ou suporte) pedindo o
   certificado do dominio proprio da hosted auth, passando a URL completa
   (`https://auth.seudominio.com.br`). Eles emitem o SSL e finalizam do lado
   deles. Exige assinatura ativa, que ja temos.
4. **Ligar no Worker**, com o host puro, sem `https://` e sem barra:
   ```bash
   npx wrangler secret put UNIPILE_AUTH_HOST
   # cole: auth.seudominio.com.br
   npm run deploy
   ```
5. **Conferir**: abrir o painel, clicar em conectar e olhar a barra de
   endereco. Tem que aparecer `auth.seudominio.com.br`. Se algo estiver errado
   na var, o link volta a sair no dominio da origem (falha aberta, de
   proposito: ninguem fica sem conectar) e o log marca
   `connect_auth_host_invalido`.

Observacoes:
- O tela em si continua sendo a da origem, so que servida no nosso dominio. A
  Unipile desaconselha embutir em iframe (quebra o captcha do LinkedIn), entao
  o CNAME e o caminho suportado.
- Enquanto o dominio nao existir, o cliente ve o dominio da origem nessa tela.
  O resto do produto (landing, painel, API, docs) nunca cita a origem.

## 4. Victor

- Revisar e fazer o merge do PR
  [vzbaggio/linkedapi-proxy#1](https://github.com/vzbaggio/linkedapi-proxy/pull/1).
- Reconectar o LinkedIn dele (sessao caida na conta-mestra).
- O backend continua na conta Cloudflare dele (decidido em 2026-09-10).

## 5. Opcionais

- **Resend** (e-mail transacional): boas-vindas com o link do painel e o
  "entrar pelo e-mail". Criar conta, verificar um dominio e rodar
  `npx wrangler secret put RESEND_API_KEY` e `npx wrangler secret put EMAIL_FROM`.
  Sem isso o acesso fica salvo no navegador de quem pagou; plano B do
  operador: `npm run portal:link -- <tenant_id>`.
- **Dominio proprio** quando houver nome definitivo: apontar na Vercel,
  adicionar a origem no CORS (`src/index.ts`), trocar `PORTAL_URL` no
  `wrangler.jsonc` e fazer o passo 3 acima (`auth.` da tela de conexao).
- Definir tiers de plano (hoje `basic` + override manual de limites).

---

O que sobra depois disso esta em [docs/pendencias.md](docs/pendencias.md).
