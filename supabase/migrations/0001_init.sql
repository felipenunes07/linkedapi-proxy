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
