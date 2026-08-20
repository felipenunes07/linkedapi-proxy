-- bootstrap.sql: as migrations 0001..0007 concatenadas para colar UMA vez no
-- SQL Editor de um projeto Supabase novo/restaurado. Fonte da verdade sao os
-- arquivos em supabase/migrations/; se eles mudarem, regenere este arquivo
-- (concatene as migrations na ordem, com este cabecalho).

-- Migration 0001. Modelo de dados minimo da V1 para provar isolamento
-- multi-tenant (PRD secao 8). Aplicada no Marco 2 no projeto Supabase
-- `linkedapi-proxy` (sa-east-1).

create extension if not exists "pgcrypto";

-- O cliente.
create table if not exists tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  status      text not null default 'active',
  created_at  timestamptz not null default now()
);

-- Chaves de API. Guardamos APENAS o hash. O valor em claro so existe na criacao.
create table if not exists api_keys (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  key_hash    text not null unique,
  status      text not null default 'active',
  created_at  timestamptz not null default now()
);
create index if not exists api_keys_tenant_idx on api_keys(tenant_id);

-- Vinculo entre tenant e a conta real na Unipile (conta-mestra unica).
create table if not exists connected_accounts (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  unipile_account_id  text not null,
  provider            text not null default 'linkedin',
  status              text not null default 'active',
  created_at          timestamptz not null default now()
);
create index if not exists connected_accounts_tenant_idx
  on connected_accounts(tenant_id);

-- RLS: defesa em profundidade. O Worker fala com o banco SO pela service role
-- key (que contorna a RLS), e o codigo TAMBEM filtra por tenant_id sempre.
-- Estrategia de isolamento escolhida: nenhum acesso pelos papeis publicos
-- (anon/authenticated). RLS ligada + zero policy permissiva = deny total para
-- esses papeis; e revogamos os grants padrao do Supabase por garantia.
alter table tenants enable row level security;
alter table api_keys enable row level security;
alter table connected_accounts enable row level security;

-- Sem nenhuma policy, RLS nega tudo para papeis nao-superusuario. Reforcamos
-- revogando os privilegios que o Supabase concede por padrao a anon/authenticated.
-- Assim, mesmo que alguem crie uma policy permissiva por engano no futuro, os
-- grants de tabela ja nao existem para esses papeis.
revoke all on tenants from anon, authenticated;
revoke all on api_keys from anon, authenticated;
revoke all on connected_accounts from anon, authenticated;

-- Migration 0002. Constraints de integridade (endurecimento pre-Marco 4).
--
-- Motivo: o callback da auto-conexao (Marco 4) passa a ESCREVER em
-- connected_accounts a partir de uma rota publica. Antes disso, o banco precisa
-- garantir sozinho o que hoje so a disciplina do codigo garante:
--   1. o mesmo unipile_account_id NUNCA pode apontar para dois tenants
--      (seria vazamento cross-tenant por dados, mesmo com o Worker correto);
--   2. colunas status so aceitam estados conhecidos (um typo nao cria um
--      estado invalido silencioso que o filtro `status=eq.active` ignoraria).
--
-- Idempotente (como a 0001): re-execucao nao falha. Se alguma constraint nao
-- puder ser criada por dados sujos pre-existentes (duplicata ou status fora da
-- lista), o erro DEVE aparecer: limpe os dados e rode de novo. Apos aplicar,
-- confira: select conname from pg_constraint where conname like '%_check' or
-- conname like '%unipile_account_id_key';

-- 1. Uma conta Unipile pertence a NO MAXIMO um tenant, uma linha.
do $$ begin
  alter table connected_accounts
    add constraint connected_accounts_unipile_account_id_key
    unique (unipile_account_id);
exception
  when duplicate_object then null;
  when duplicate_table then null;
end $$;

-- 2. Estados validos, por tabela.
-- tenants: ativo ou suspenso (suspensao corta o acesso na hora, ver resolveTenant).
do $$ begin
  alter table tenants
    add constraint tenants_status_check
    check (status in ('active', 'suspended'));
exception
  when duplicate_object then null;
end $$;

-- api_keys: ativa ou revogada (revogacao e soft, nunca delete; trilha de auditoria).
do $$ begin
  alter table api_keys
    add constraint api_keys_status_check
    check (status in ('active', 'revoked'));
exception
  when duplicate_object then null;
end $$;

-- connected_accounts: ativa, pausada (ex.: inadimplencia, fase 2; pausa NAO se
-- desfaz por reconexao) ou desconectada (sessao LinkedIn caiu; Marco 4 reconecta).
do $$ begin
  alter table connected_accounts
    add constraint connected_accounts_status_check
    check (status in ('active', 'paused', 'disconnected'));
exception
  when duplicate_object then null;
end $$;

-- Migration 0003. Tokens de auto-conexao (Marco 4, hosted auth).
--
-- Fluxo: o operador gera um link de conexao para um tenant (scripts/connect.ts).
-- O link carrega um token opaco de uso unico (campo `name` da hosted auth), que
-- volta no callback (`POST /hooks/connect`). O callback e uma rota PUBLICA: o
-- token e o que vincula, com seguranca, a conta conectada ao tenant certo.
--
-- Regras (iguais as de api_keys):
--   - guardamos APENAS o hash do token; o claro so aparece dentro do link;
--   - uso unico: status pending -> used; token usado nao vincula de novo;
--   - expira: o callback so aceita token dentro da validade (expires_at).

create table if not exists connect_tokens (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  token_hash  text not null unique,
  purpose     text not null default 'create'
              check (purpose in ('create', 'reconnect')),
  status      text not null default 'pending'
              check (status in ('pending', 'used')),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists connect_tokens_tenant_idx on connect_tokens(tenant_id);

-- Mesma estrategia de RLS das outras tabelas: deny total a papeis publicos.
-- So a service role (Worker e scripts) toca nesta tabela.
alter table connect_tokens enable row level security;
revoke all on connect_tokens from anon, authenticated;

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

-- Migration 0006. Webhook do cliente (fase 2).
--
-- O tenant pode registrar uma URL para receber eventos (ex.: mensagem
-- recebida), assinados com HMAC-SHA256. O secret fica em claro nesta tabela
-- (precisa ser recuperavel para assinar); a tabela e service-role-only como as
-- demais, e o secret e gerado por nos com 256 bits (nunca escolhido pelo
-- cliente). URL obrigatoriamente https (validado no Worker).

alter table tenants add column if not exists webhook_url text;
alter table tenants add column if not exists webhook_secret text;

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

