-- Migration 0013. Uso persistente das acoes novas (F2.41).
--
-- A API passou de 3 para todos os endpoints de LinkedIn, e cada familia de
-- chamada que toca o LinkedIn ao vivo ganhou o seu limite diario
-- (src/lib/limits.ts). O historico em usage_daily so aceitava 'messages' e
-- 'invitations': sem esta migration o incremento das acoes novas falha (em
-- silencio, e best-effort) e o painel mostra zero.
--
-- Duas mudancas:
--   1. o CHECK de action passa a aceitar as acoes novas;
--   2. increment_usage ganha uma sobrecarga com p_count, porque o limite de
--      busca e medido em RESULTADOS devolvidos, nao em chamadas. A assinatura
--      antiga (3 argumentos) continua existindo e atendendo o de sempre.

alter table usage_daily drop constraint if exists usage_daily_action_check;
alter table usage_daily
  add constraint usage_daily_action_check
  check (action in (
    'messages',
    'invitations',
    'profile_views',
    'search_results',
    'network_reads',
    'content_reads',
    'invitation_responses',
    'reactions',
    'comments',
    'posts',
    'chat_actions'
  ));

create or replace function increment_usage(
  p_tenant_id uuid,
  p_action text,
  p_day date,
  p_count integer
) returns void
language sql
security definer
set search_path = public
as $$
  insert into usage_daily (tenant_id, action, day, count)
  values (p_tenant_id, p_action, p_day, greatest(p_count, 0))
  on conflict (tenant_id, action, day)
  do update set count = usage_daily.count + greatest(p_count, 0);
$$;

revoke execute on function increment_usage(uuid, text, date, integer)
  from public, anon, authenticated;
