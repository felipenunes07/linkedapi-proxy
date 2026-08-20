import type { Env, Tenant } from '../types';
import { supabaseSelect, supabaseUpdate } from './supabase';
import { hashApiKey } from './hash';
import { DAILY_LIMITS } from './limits';

// Re-exportado por compatibilidade: o hash agora vive em ./hash (compartilhado
// com o script de emissao de chave). Quem ja importava hashApiKey daqui continua
// funcionando.
export { hashApiKey };

// Resolucao de tenant e account_id. Esta e a fronteira de seguranca #1:
// a unica origem legitima do account_id e a cadeia
//   API key -> api_keys.tenant_id -> connected_accounts.unipile_account_id
// NUNCA o request do cliente.
//
// Marco 2: implementado contra o Supabase (PostgREST + service role).
// - hasheia a apiKey recebida e busca em api_keys (status ativo)
// - confirma que o tenant esta ativo (status), para suspensao ter efeito imediato
// - carrega a connected_account do tenant (provider linkedin, ativa)
// - retorna null se a chave for invalida/revogada, o tenant suspenso, ou nao
//   houver conta

interface ApiKeyRow {
  tenant_id: string;
}

interface TenantRow {
  id: string;
  daily_message_limit?: number | null;
  daily_invitation_limit?: number | null;
}

interface ConnectedAccountRow {
  unipile_account_id: string;
}

export async function resolveTenant(
  env: Env,
  apiKey: string,
): Promise<Tenant | null> {
  const keyHash = await hashApiKey(apiKey);

  // Chave -> tenant. Guardamos so o hash; comparamos por hash.
  const keys = await supabaseSelect<ApiKeyRow>(env, 'api_keys', {
    key_hash: `eq.${keyHash}`,
    status: 'eq.active',
    select: 'tenant_id',
    limit: '1',
  });
  const tenantId = keys[0]?.tenant_id;
  if (!tenantId) {
    return null;
  }

  // Tenant ativo? Uma chave valida de um tenant suspenso nao age. Suspender o
  // tenant (status != active) passa a ter efeito imediato, sem precisar mexer
  // em cada connected_account. Aproveita a query para carregar os overrides de
  // limite do plano (fase 2; NULL = default do plano basico).
  const tenants = await supabaseSelect<TenantRow>(env, 'tenants', {
    id: `eq.${tenantId}`,
    status: 'eq.active',
    select: 'id,daily_message_limit,daily_invitation_limit',
    limit: '1',
  });
  const tenantRow = tenants[0];
  if (!tenantRow) {
    return null;
  }

  // Tenant -> account_id. Filtra por tenant_id no codigo (defesa em
  // profundidade), mesmo a service role contornando a RLS. Ordena por
  // created_at desc: se houver mais de uma conta ativa (nao deveria; o
  // callback do Marco 4 desativa as demais), vence a mais recente de forma
  // deterministica, nunca uma linha arbitraria.
  const accounts = await supabaseSelect<ConnectedAccountRow>(
    env,
    'connected_accounts',
    {
      tenant_id: `eq.${tenantId}`,
      provider: 'eq.linkedin',
      status: 'eq.active',
      select: 'unipile_account_id',
      order: 'created_at.desc',
      limit: '1',
    },
  );
  const unipileAccountId = accounts[0]?.unipile_account_id;
  if (!unipileAccountId) {
    return null;
  }

  return {
    tenantId,
    unipileAccountId,
    limits: {
      messages: tenantRow.daily_message_limit ?? DAILY_LIMITS.messages,
      invitations: tenantRow.daily_invitation_limit ?? DAILY_LIMITS.invitations,
    },
    keyHash,
  };
}

// Auditoria: registra o ultimo uso da chave. Best-effort de proposito (chamado
// via fireAndForget no auth): falha aqui nunca pode afetar a request. Filtra
// tambem por tenant_id (defesa em profundidade, mesmo key_hash sendo unique).
export async function touchApiKey(
  env: Env,
  keyHash: string,
  tenantId: string,
): Promise<void> {
  await supabaseUpdate(
    env,
    'api_keys',
    { key_hash: `eq.${keyHash}`, tenant_id: `eq.${tenantId}` },
    { last_used_at: new Date().toISOString() },
  );
}
