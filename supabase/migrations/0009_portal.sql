-- Migration 0009. Painel do cliente e onboarding automatico (decisoes F2.20
-- e F2.21, esta ultima vinda do security review do F2.20).
--
-- Antes: o cliente pagava e parava ali; o operador rodava connect:link e
-- key:issue na mao e mandava tudo por fora. Agora o proprio cliente, pelo
-- painel da landing, conecta o LinkedIn e gera a chave.
--
-- Mudancas:
--   1. tenants.contact_email: o e-mail que o comprador digitou no checkout,
--      normalizado. So para os avisos da conta (boas-vindas, link de acesso).
--      Dado pessoal: nunca vai para log nem sai em resposta a terceiros.
--   2. tenants.welcome_sent_at: trava do e-mail de boas-vindas (sai uma vez;
--      se o envio falhar, volta a NULL e o proximo evento de pagamento tenta).
--   3. portal_tokens: credenciais do painel, SO o hash. Dois tipos:
--        session (lk_portal_): vive no navegador do cliente, 14 dias.
--        link    (lk_plink_):  vai DENTRO do e-mail; uso unico e curto, so
--                              serve para ser trocado por uma sessao. A copia
--                              que fica no provedor de e-mail ou num Safe Links
--                              nao vira acesso depois de usada ou vencida.
--   4. find_tenants_by_contact_email: busca por e-mail via RPC, com o e-mail
--      no CORPO da chamada. Um filtro ?contact_email=eq.<email> poria o
--      endereco no query string, que fica nos logs de API.

alter table tenants add column if not exists contact_email text;
alter table tenants add column if not exists welcome_sent_at timestamptz;
create index if not exists tenants_contact_email_idx on tenants(contact_email);

create table if not exists portal_tokens (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  token_hash  text not null unique,
  kind        text not null default 'session'
              check (kind in ('session', 'link')),
  status      text not null default 'active'
              check (status in ('active', 'used', 'revoked')),
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists portal_tokens_tenant_idx on portal_tokens(tenant_id);

-- Mesma estrategia de RLS das outras tabelas: deny total a papeis publicos.
-- So a service role (Worker e scripts) toca nesta tabela.
alter table portal_tokens enable row level security;
revoke all on portal_tokens from anon, authenticated;

-- SECURITY INVOKER de proposito (review F2.21, M4): o unico chamador e a
-- service role, que ja ignora a RLS. Com DEFINER, uma recriacao pelo dashboard
-- sem o revoke abaixo viraria um oraculo publico de "este e-mail e cliente?".
create or replace function find_tenants_by_contact_email(p_email text)
returns table (id uuid)
language sql
stable
security invoker
set search_path = public
as $$
  select t.id
  from tenants t
  where t.contact_email = lower(trim(p_email))
    and t.status = 'active'
  order by t.created_at desc
  limit 5;
$$;

revoke execute on function find_tenants_by_contact_email(text)
  from public, anon, authenticated;
grant execute on function find_tenants_by_contact_email(text) to service_role;
