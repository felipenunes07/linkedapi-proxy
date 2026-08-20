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
