-- Migration 0005. Uso persistente (fase 2).
--
-- O contador KV do rate limit expira em 2 dias: serve para proteger, nao para
-- faturar nem auditar. Esta tabela guarda o historico diario por tenant/acao.
-- A escrita e best-effort no Worker (waitUntil, nunca bloqueia a resposta) via
-- RPC atomica increment_usage. api_keys ganha last_used_at para auditoria.

create table if not exists usage_daily (
  tenant_id  uuid not null references tenants(id) on delete cascade,
  action     text not null check (action in ('messages', 'invitations')),
  day        date not null,
  count      integer not null default 0,
  primary key (tenant_id, action, day)
);

alter table usage_daily enable row level security;
revoke all on usage_daily from anon, authenticated;

-- Incremento atomico (upsert). SECURITY DEFINER + revoke: so a service role
-- (que tem grants proprios) executa.
create or replace function increment_usage(
  p_tenant_id uuid,
  p_action text,
  p_day date
) returns void
language sql
security definer
set search_path = public
as $$
  insert into usage_daily (tenant_id, action, day, count)
  values (p_tenant_id, p_action, p_day, 1)
  on conflict (tenant_id, action, day)
  do update set count = usage_daily.count + 1;
$$;

revoke execute on function increment_usage(uuid, text, date)
  from public, anon, authenticated;

alter table api_keys add column if not exists last_used_at timestamptz;
