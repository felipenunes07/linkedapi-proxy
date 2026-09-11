-- Migration 0011. Assentos adicionais (F2.29): o mesmo cliente contrata uma
-- segunda conta de LinkedIn pelo MESMO checkout, sem perder a primeira.
--
-- Decisao de modelo: 1 assento continua sendo 1 tenant, com a propria
-- assinatura, a propria conta e a propria chave. Nada muda na regra inviolavel
-- #1 (account_id resolvido da chave -> tenant -> connected_accounts) nem no
-- teste de isolamento. O que entra e um AGRUPAMENTO entre os tenants do mesmo
-- cliente, para o painel listar as contas e alternar entre elas.
--
--   1. tenants.group_id: uuid do tenant que abriu o grupo (sem FK de
--      proposito: a faxina pode apagar um tenant que nunca pagou, e os irmaos
--      continuam agrupados pelo mesmo valor). NULL = tenant sozinho.
--
--      IMPORTANT: grupo NUNCA se forma por e-mail igual. So a rota autenticada
--      do painel (POST /portal/seat -> checkout com seat_token de uso unico)
--      poe um tenant novo no grupo de quem ja esta logado. Agrupar por
--      contact_email deixaria qualquer um que pagasse com o e-mail da vitima
--      entrar no painel dela.
--
--   2. portal_tokens.kind ganha 'seat': o token de uso unico que autoriza o
--      checkout a criar um assento DENTRO de um grupo existente. Mesma
--      disciplina dos outros: so o hash no banco, uso unico, expira.
--
--   3. connected_accounts.label: o nome do perfil que a origem confirma no
--      callback de conexao. E o que a lista de contas do painel mostra, para o
--      cliente com duas contas saber qual e qual. Nunca o id da origem.

alter table tenants add column if not exists group_id uuid;
create index if not exists tenants_group_idx on tenants(group_id);

alter table connected_accounts add column if not exists label text;

do $$ begin
  alter table portal_tokens drop constraint portal_tokens_kind_check;
exception when undefined_object then null;
end $$;

alter table portal_tokens
  add constraint portal_tokens_kind_check
  check (kind in ('session', 'link', 'seat'));
