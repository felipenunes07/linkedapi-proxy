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
