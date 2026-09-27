-- Migration 0014. Varios webhooks por conta, cada um com os seus eventos
-- (F2.43).
--
-- Ate aqui o tenant tinha UM endpoint (tenants.webhook_url/webhook_secret) que
-- recebia todo evento. Agora, como no dashboard da origem, o cliente cria
-- quantos webhooks quiser (teto no Worker), cada um com nome, URL, secret
-- proprio e a lista de eventos que o dispara.
--
-- A tabela propria tambem fecha a pendencia antiga: o secret sai de `tenants`,
-- onde qualquer select:* futuro o vazaria. Continua sendo o unico segredo
-- recuperavel do banco (decisao F2.5): precisa dele para assinar cada evento.
--
-- O endpoint que ja existia vira o primeiro webhook da conta, com TODOS os
-- eventos de antes (mensagem nova, conexao caiu, conexao voltou), para nada
-- mudar para quem ja integrou. As colunas antigas ficam ate uma migration de
-- limpeza: o Worker novo nao le mais nenhuma delas.

create table if not exists client_webhooks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60),
  url         text not null check (url like 'https://%' and char_length(url) <= 500),
  secret      text not null,
  events      text[] not null check (cardinality(events) > 0),
  created_at  timestamptz not null default now()
);
create index if not exists client_webhooks_tenant_idx on client_webhooks(tenant_id);
-- Entrega: "webhooks deste tenant que assinam este evento" (events @> '{x}').
create index if not exists client_webhooks_events_idx on client_webhooks using gin (events);

alter table client_webhooks enable row level security;
revoke all on client_webhooks from anon, authenticated;

insert into client_webhooks (tenant_id, name, url, secret, events)
select
  t.id,
  'Webhook principal',
  t.webhook_url,
  t.webhook_secret,
  array['message.received', 'account.disconnected', 'account.reconnected']
from tenants t
where t.webhook_url is not null
  and t.webhook_secret is not null
  and not exists (select 1 from client_webhooks w where w.tenant_id = t.id);
