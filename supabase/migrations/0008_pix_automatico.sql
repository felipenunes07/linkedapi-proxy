-- Migration 0008. Pix Automatico e checkout hospedado (decisao F2.18).
--
-- Motivo: o cartao saiu do nosso formulario (o Asaas nao oferece tokenizacao
-- no navegador e exige SAQ-D de quem digita cartao em pagina propria). O
-- caminho passa a ser:
--   Pix Automatico  -> autorizacao unica, o Asaas debita sozinho todo mes
--   Cartao          -> Checkout hospedado do Asaas (fora do nosso escopo PCI)
--
-- Duas mudancas no vinculo de cobranca:
--   1. `asaas_subscription_id` deixa de ser obrigatorio: no Pix Automatico a
--      assinatura so nasce DEPOIS que o pagador autoriza no banco dele, entao
--      no momento do checkout so temos o id da autorizacao. (O unique continua:
--      no Postgres varios NULL convivem num indice unique.)
--   2. Colunas novas para o webhook saber com o que esta lidando.

alter table billing_subscriptions
  alter column asaas_subscription_id drop not null;

alter table billing_subscriptions
  add column if not exists payment_method text;

alter table billing_subscriptions
  add column if not exists asaas_authorization_id text;

alter table billing_subscriptions
  add column if not exists asaas_checkout_id text;

do $$ begin
  alter table billing_subscriptions
    add constraint billing_subscriptions_payment_method_check
    check (payment_method is null or payment_method in ('pix', 'pix_automatic', 'card'));
exception when duplicate_object then null;
end $$;

-- O webhook resolve o tenant por assinatura OU por cliente (no Pix Automatico
-- a cobranca pode chegar antes de sabermos o id da assinatura). Indice para a
-- busca por cliente nao virar varredura.
create index if not exists billing_subscriptions_customer_idx
  on billing_subscriptions(asaas_customer_id);

create index if not exists billing_subscriptions_authorization_idx
  on billing_subscriptions(asaas_authorization_id);
