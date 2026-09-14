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

## 0b. Teste ponta a ponta de 2026-09-13 (o que ja esta provado)

Rodado contra producao, sem dinheiro:

- **A API que o cliente compra**: chave emitida, `GET /v1/chats` devolveu chats
  reais do LinkedIn em ~2s pelo dominio proprio; chave invalida e ausente dao
  401. Achado e corrigido no caminho: o cursor de paginacao deixava o cliente
  escolher a conta (F2.36).
- **Painel do cliente pago**: link do operador -> sessao -> status -> lista de
  contas -> tela de conexao (a URL volta e expira em 2h) -> chave recusada sem
  LinkedIn conectado (409, correto).
- **Conta adicional**: token de assento -> mesmo checkout -> R$ 67 na pagina do
  Asaas -> tenant novo JA no grupo -> aviso de pagamento simulado ->
  assinatura ativa -> as duas contas na lista -> troca entre elas -> sessao
  antiga revogada na troca -> `ref` de grupo alheio recusada.
- Tudo o que o teste criou foi desfeito: sessao de pagamento cancelada no
  Asaas, tenant de teste apagado, chave revogada, grupo desfeito.

O que o teste NAO cobre, e so dinheiro de verdade cobre: pagar um Pix e um
cartao e ver o webhook REAL do Asaas ativar a conta.

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

## 1b. Dominio proprio da API: FEITO em 2026-09-13 (F2.34)

A API e a documentacao atendem em `https://api.playbooklab.com.br`. O Worker
mudou de conta Cloudflare (do Victor para a do Fernando, `31dab3c5...`), porque
custom domain exige zona e Worker na MESMA conta e a zona
`playbooklab.com.br` esta la. O que foi migrado: KV novo
(`b79c9339...`), os 10 secrets, o dominio proprio e os webhooks.

~~Falta um clique~~ FEITO: a conta ganhou o subdominio `fernando-31d.workers.dev`
e o cron da faxina voltou (`schedule: 23 * * * *` confirmado no deploy).

~~Apagar o Worker antigo~~ FEITO em 2026-09-13: o endereco antigo responde 404
e o novo segue verde (health, docs, painel, banco e os tres hooks). Sobra na
conta do Victor, inofensivo, o KV `linkedapi-proxy-RATE_LIMIT`, que nao some
junto com o Worker: da para apagar em Storage & Databases > KV. O projeto
Pages `linkedapi-site` FICA: e o endereco antigo da landing, que so
redireciona.

Webhooks ja reapontados para o dominio novo e conferidos no ar:
- Unipile `linkedapi-account-status` e `linkedapi-message-received` (os antigos
  foram apagados; os outros 5 webhooks da conta, de outros projetos, nao foram
  tocados);
- Asaas `LinkedAPI billing` (`PUT /v3/webhooks`, 5 eventos, enabled).

## 2. Empresa e juridico (antes de mandar trafego pago)

- **Dados da empresa** em `termos.html` e `privacidade.html` (repo da landing):
  razao social, CNPJ, endereco, cidade do foro e nome do encarregado (DPO).
  Estao marcados em amarelo.
- **Revisao por advogado** dos termos e da politica (rascunhos completos para
  LGPD e CDC, nao revisados).
- **Nota fiscal** da cobranca recorrente.
- **Nome definitivo** do produto (o atual e provisorio). Ao trocar, seguir a
  lista de arquivos no README da landing.

## 3. Tela de conexao no nosso dominio: FEITO em 2026-09-14 (F2.30)

O suporte da origem emitiu o certificado e o `UNIPILE_AUTH_HOST` foi ligado no
Worker. Conferido no ar:

- certificado `CN=auth.playbooklab.com.br` (Let's Encrypt), handshake 200;
- `POST /portal/connect` devolve link em `auth.playbooklab.com.br`;
- o link abre a tela de conexao de verdade, sem aviso de certificado.

A partir daqui o cliente nao ve o nome da origem em nenhuma tela do produto.

Duas observacoes da tela, para decidir depois:

1. Ela oferece dois metodos, "Credentials" e "Cookies". O segundo pede o
   cookie de sessao do LinkedIn, coisa de gente tecnica; da para deixar so o
   primeiro com `disabled_options: ['cookie_auth']` no link.
2. Ela abriu em ingles no navegador do teste. Se nao seguir o idioma de quem
   abre, vale procurar o parametro de idioma antes do primeiro cliente.

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
