-- bootstrap.sql: as migrations 0001..0010 concatenadas para colar UMA vez no
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

-- Migration 0008. Pix Automatico e checkout hospedado (decisao F2.18).
--
-- Motivo: o cartao saiu do nosso formulario (o Asaas nao oferece tokenizacao
-- no navegador e exige SAQ-D de quem digita cartao em pagina propria). O
-- caminho passa a ser:
--   Pix Automatico  -> autorizacao unica, o Asaas debita sozinho todo mes
--   Cartao          -> Checkout hospedado do Asaas (fora do nosso escopo PCI)
--
-- Duas mudancas no vinculo de cobranca:
--   1. `asaas_subscription_id` deixa de ser obrigatorio: no Pix Automatico a
--      assinatura so nasce DEPOIS que o pagador autoriza no banco dele, entao
--      no momento do checkout so temos o id da autorizacao. (O unique continua:
--      no Postgres varios NULL convivem num indice unique.)
--   2. Colunas novas para o webhook saber com o que esta lidando.

alter table billing_subscriptions
  alter column asaas_subscription_id drop not null;

alter table billing_subscriptions
  add column if not exists payment_method text;

alter table billing_subscriptions
  add column if not exists asaas_authorization_id text;

alter table billing_subscriptions
  add column if not exists asaas_checkout_id text;

do $$ begin
  alter table billing_subscriptions
    add constraint billing_subscriptions_payment_method_check
    check (payment_method is null or payment_method in ('pix', 'pix_automatic', 'card'));
exception when duplicate_object then null;
end $$;

-- O webhook resolve o tenant por assinatura OU por cliente (no Pix Automatico
-- a cobranca pode chegar antes de sabermos o id da assinatura). Indice para a
-- busca por cliente nao virar varredura.
create index if not exists billing_subscriptions_customer_idx
  on billing_subscriptions(asaas_customer_id);

create index if not exists billing_subscriptions_authorization_idx
  on billing_subscriptions(asaas_authorization_id);

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

-- Migration 0010. Cartao recorrente pelo checkout hospedado do Asaas (F2.25,
-- endurecido pelo security review).
--
-- Confirmado no real em 2026-09-10: o checkout do Asaas NAO aceita cliente
-- pre-criado (o campo `customer` e recusado, mesmo com id existente). Quem
-- cria o cliente e a propria pagina do Asaas, entao:
--   1. asaas_customer_id pode nascer vazio no cartao (e preenchido quando o
--      primeiro pagamento chega pelo webhook);
--   2. a ANCORA do cartao e asaas_checkout_id: o id da sessao que NOS criamos,
--      que volta em `payment.checkoutSession` e no evento CHECKOUT_PAID. Unico:
--      uma sessao nunca aponta para dois tenants, nem sob corrida. Varios NULL
--      convivem (Pix nao tem checkout).

alter table billing_subscriptions
  alter column asaas_customer_id drop not null;

create unique index if not exists billing_subscriptions_checkout_uidx
  on billing_subscriptions(asaas_checkout_id)
  where asaas_checkout_id is not null;

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
