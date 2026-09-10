-- Migration 0010. Cartao recorrente pelo checkout hospedado do Asaas (F2.25,
-- endurecido pelo security review).
--
-- Confirmado no real em 2026-09-10: o checkout do Asaas NAO aceita cliente
-- pre-criado (o campo `customer` e recusado, mesmo com id existente). Quem
-- cria o cliente e a propria pagina do Asaas, entao:
--   1. asaas_customer_id pode nascer vazio no cartao (e preenchido quando o
--      primeiro pagamento chega pelo webhook);
--   2. a ANCORA do cartao e asaas_checkout_id: o id da sessao que NOS criamos,
--      que volta em `payment.checkoutSession` e no evento CHECKOUT_PAID. Unico:
--      uma sessao nunca aponta para dois tenants, nem sob corrida. Varios NULL
--      convivem (Pix nao tem checkout).

alter table billing_subscriptions
  alter column asaas_customer_id drop not null;

create unique index if not exists billing_subscriptions_checkout_uidx
  on billing_subscriptions(asaas_checkout_id)
  where asaas_checkout_id is not null;
