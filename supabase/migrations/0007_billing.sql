-- Migration 0007. Billing via Asaas (fase 2).
--
-- Assinatura Pix mensal por tenant. Regra do PRD: inadimplencia PAUSA o
-- account_id (connected_accounts.status = 'paused'), nunca deleta; pagamento
-- confirmado despausa. O Worker so processa o webhook do Asaas; a criacao de
-- cliente/assinatura e feita pelo operador via script (billing:subscribe).

create table if not exists billing_subscriptions (
  tenant_id              uuid primary key references tenants(id) on delete cascade,
  asaas_customer_id      text not null,
  asaas_subscription_id  text not null unique,
  status                 text not null default 'pending'
                         check (status in ('pending', 'active', 'overdue', 'canceled')),
  updated_at             timestamptz not null default now(),
  created_at             timestamptz not null default now()
);

alter table billing_subscriptions enable row level security;
revoke all on billing_subscriptions from anon, authenticated;
