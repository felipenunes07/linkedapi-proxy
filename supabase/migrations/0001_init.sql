-- RASCUNHO. Revisar e ajustar no Marco 2 antes de aplicar.
-- Modelo de dados minimo da V1 para provar isolamento multi-tenant (PRD secao 8).

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

-- RLS: defesa em profundidade. O Worker usa a service role key (que contorna
-- RLS), entao o codigo TAMBEM deve filtrar por tenant_id sempre. As policies
-- abaixo protegem qualquer acesso que passe pelo papel autenticado do Postgres.
alter table tenants enable row level security;
alter table api_keys enable row level security;
alter table connected_accounts enable row level security;

-- TODO(Marco 2): definir as policies conforme a estrategia de isolamento
-- escolhida (ex.: claim de tenant no JWT, ou acesso so via service role no
-- Worker com filtro explicito por tenant_id). Nao deixar as tabelas sem policy
-- e acessiveis pelo papel anon.
