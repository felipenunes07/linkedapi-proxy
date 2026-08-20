-- Migration 0004. Planos e limites por tenant (fase 2).
--
-- Ate aqui os limites diarios eram constantes globais no Worker (80/30). Para
-- vender tiers diferentes sem mudar codigo, o tenant ganha overrides opcionais:
-- NULL = usa o default do plano basico (constantes do Worker). O rate limiter
-- le esses valores na resolucao do tenant.
--
-- Os tetos dos CHECKs sao os limites SEGUROS do provedor (Unipile Provider
-- Limits: mensagens ~100/dia, convites 80-100/dia): a regra inviolavel #4 pede
-- limites conservadores por design. Valor acima disso exige nova migration,
-- de proposito.

alter table tenants add column if not exists plan text not null default 'basic';
alter table tenants add column if not exists daily_message_limit integer;
alter table tenants add column if not exists daily_invitation_limit integer;

do $$ begin
  alter table tenants
    add constraint tenants_daily_message_limit_check
    check (daily_message_limit is null or daily_message_limit between 1 and 150);
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table tenants
    add constraint tenants_daily_invitation_limit_check
    check (daily_invitation_limit is null or daily_invitation_limit between 1 and 100);
exception when duplicate_object then null;
end $$;
