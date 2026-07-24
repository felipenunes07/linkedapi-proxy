import type { Env, Tenant } from '../types';
import { supabaseSelect } from './supabase';

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
  // em cada connected_account.
  const tenants = await supabaseSelect<TenantRow>(env, 'tenants', {
    id: `eq.${tenantId}`,
    status: 'eq.active',
    select: 'id',
    limit: '1',
  });
  if (!tenants[0]) {
    return null;
  }

  // Tenant -> account_id. Filtra por tenant_id no codigo (defesa em
  // profundidade), mesmo a service role contornando a RLS.
  const accounts = await supabaseSelect<ConnectedAccountRow>(
    env,
    'connected_accounts',
    {
      tenant_id: `eq.${tenantId}`,
      provider: 'eq.linkedin',
      status: 'eq.active',
      select: 'unipile_account_id',
      limit: '1',
    },
  );
  const unipileAccountId = accounts[0]?.unipile_account_id;
  if (!unipileAccountId) {
    return null;
  }

  return { tenantId, unipileAccountId };
}

// Hash da API key. Guardamos apenas o hash; comparamos por hash. A chave em
// claro tem alta entropia (gerada aleatoriamente na criacao), entao SHA-256 e
// adequado aqui. Se um dia a chave passar a ter baixa entropia, trocar por HMAC
// com salt do servidor.
export async function hashApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
