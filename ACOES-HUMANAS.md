# Acoes humanas (o que SO uma pessoa pode fazer para o projeto avancar)

Todo o codigo esta pronto, testado (223 testes) e revisado. Este arquivo lista
APENAS o que precisa de mao humana. Os comandos de deploy estao em
[docs/go-live.md](docs/go-live.md) (secoes H e I).

Atualizado em 2026-09-10.

Onde fica cada coisa:
- Landing e painel: Vercel, https://landing-api-linkedin.vercel.app (deploy a
  cada push no `master` do repo da landing).
- Backend: Cloudflare Workers na conta do Victor,
  https://linkedapi-proxy.victor-58a.workers.dev (`npm run deploy`).
- Nome do produto: "Playbook API" e PROVISORIO. Contato publicado:
  victor@playbooklab.com.br.

---

## 1. Provar com dinheiro de verdade

- **Antes da compra no cartao: cadastrar o site na conta Asaas.** No painel
  do Asaas, Minha Conta > Informacoes > Site:
  `https://landing-api-linkedin.vercel.app` (hoje o campo esta vazio). O
  checkout de cartao devolve o cliente para esse dominio depois do
  pagamento. E dado cadastral da empresa, por isso fica com voces.
- **Uma compra no Pix e uma no cartao** (R$ 57 cada), com CPF e LinkedIn da
  equipe: checkout -> pagamento -> painel -> conectar LinkedIn -> gerar chave.
  E a unica prova ponta a ponta do fluxo inteiro. No cartao, conferir no mes
  seguinte que a renovacao continua ativando a conta. Depois, cancelar pelo
  app do banco (Pix) ou pedindo o cancelamento (cartao).

## 2. Empresa e juridico (antes de mandar trafego pago)

- **Dados da empresa** em `termos.html` e `privacidade.html` (repo da landing):
  razao social, CNPJ, endereco, cidade do foro e nome do encarregado (DPO).
  Estao marcados em amarelo.
- **Revisao por advogado** dos termos e da politica (rascunhos completos para
  LGPD e CDC, nao revisados).
- **Nota fiscal** da cobranca recorrente.
- **Nome definitivo** do produto (o atual e provisorio). Ao trocar, seguir a
  lista de arquivos no README da landing.

## 3. Victor

- Revisar e fazer o merge do PR
  [vzbaggio/linkedapi-proxy#1](https://github.com/vzbaggio/linkedapi-proxy/pull/1).
- Reconectar o LinkedIn dele (sessao caida na conta-mestra).
- O backend continua na conta Cloudflare dele (decidido em 2026-09-10).

## 4. Opcionais

- **Resend** (e-mail transacional): boas-vindas com o link do painel e o
  "entrar pelo e-mail". Criar conta, verificar um dominio e rodar
  `npx wrangler secret put RESEND_API_KEY` e `npx wrangler secret put EMAIL_FROM`.
  Sem isso o acesso fica salvo no navegador de quem pagou; plano B do
  operador: `npm run portal:link -- <tenant_id>`.
- **Dominio proprio** quando houver nome definitivo: apontar na Vercel,
  adicionar a origem no CORS (`src/index.ts`) e trocar `PORTAL_URL` no
  `wrangler.jsonc`.
- Definir tiers de plano (hoje `basic` + override manual de limites).

---

O que sobra depois disso esta em [docs/pendencias.md](docs/pendencias.md).
