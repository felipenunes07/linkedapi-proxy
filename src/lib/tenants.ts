import type { Env, Tenant } from '../types';
import { supabaseSelect, supabaseUpdate } from './supabase';
import { hashApiKey } from './hash';
import { effectiveLimits } from './limits';

// Re-exportado por compatibilidade: o hash agora vive em ./hash (compartilhado
// com o script de emissao de chave). Quem ja importava hashApiKey daqui continua
// funcionando.
export { hashApiKey };

// Resolucao de tenant e account_id. Esta e a fronteira de seguranca #1:
// a unica origem legitima do account_id e a cadeia
//   API key -> api_keys.tenant_id -> connected_accounts.unipile_account_id
// NUNCA o request do cliente.
//
// F2.42: o cliente pode ESCOLHER entre as contas do proprio grupo com o nosso
// `account_id` publico (acc_..., ver lib/contas). A escolha e so um ponteiro
// para um assento que o servidor confere ser do grupo da chave; o id da
// origem continua saindo desta cadeia, nunca do request.
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

// Resultado detalhado (F2.22): chave valida de tenant ativo SEM LinkedIn ativo
// deixa de virar o mesmo 401 de chave invalida. O cliente fica sabendo o
// motivo (pagamento em atraso, sessao caida, nunca conectou) em vez de achar
// que a chave quebrou. Chave inexistente/revogada e tenant suspenso seguem
// 401 identicos: para quem nao tem chave valida, nada muda.
export type TenantResolution =
  | { tenant: Tenant }
  | { error: 'invalid_api_key'; status: 401 }
  | { error: 'account_not_found'; status: 404 }
  | { error: 'account_paused'; status: 402 }
  | { error: 'account_disconnected' | 'linkedin_not_connected'; status: 409 };

const CHAVE_INVALIDA = { error: 'invalid_api_key', status: 401 } as const;

interface AccountStatusRow {
  status: string;
}

// So roda para quem ja provou posse de chave valida de tenant ativo: o motivo
// e da PROPRIA conta, nunca de outra. Pausa (billing) vence desconexao.
async function motivoSemContaAtiva(
  env: Env,
  tenantId: string,
): Promise<TenantResolution> {
  const rows = await supabaseSelect<AccountStatusRow>(env, 'connected_accounts', {
    tenant_id: `eq.${tenantId}`,
    provider: 'eq.linkedin',
    status: 'in.(paused,disconnected)',
    select: 'status',
  });
  if (rows.some((r) => r.status === 'paused')) {
    return { error: 'account_paused', status: 402 };
  }
  if (rows.some((r) => r.status === 'disconnected')) {
    return { error: 'account_disconnected', status: 409 };
  }
  return { error: 'linkedin_not_connected', status: 409 };
}

export async function resolveTenant(
  env: Env,
  apiKey: string,
): Promise<Tenant | null> {
  const resolved = await resolveTenantDetailed(env, apiKey);
  return 'tenant' in resolved ? resolved.tenant : null;
}

export async function resolveTenantDetailed(
  env: Env,
  apiKey: string,
): Promise<TenantResolution> {
  const chave = await autenticarChave(env, apiKey);
  if (!chave) {
    return CHAVE_INVALIDA;
  }
  return resolverContaDoTenant(env, chave.tenantId, chave, chave.tenantRow);
}

// Chave valida de tenant ativo. E a primeira metade da cadeia: quem e o dono
// da chave. A conta com que a request age sai de resolverContaDoTenant.
export interface ChaveAutenticada {
  tenantId: string;
  keyHash: string;
  tenantRow: TenantRow;
}

export async function autenticarChave(
  env: Env,
  apiKey: string,
): Promise<ChaveAutenticada | null> {
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
  const tenantRow = await tenantAtivo(env, tenantId);
  if (!tenantRow) {
    return null;
  }
  return { tenantId, keyHash, tenantRow };
}

async function tenantAtivo(env: Env, tenantId: string): Promise<TenantRow | null> {
  const tenants = await supabaseSelect<TenantRow>(env, 'tenants', {
    id: `eq.${tenantId}`,
    status: 'eq.active',
    select: 'id,daily_message_limit,daily_invitation_limit',
    limit: '1',
  });
  return tenants[0] ?? null;
}

// Segunda metade: a conta LinkedIn com que a request age. Normalmente e a do
// dono da chave. Com `account_id` no request (F2.42), e a de outro assento do
// MESMO grupo, que lib/contas ja conferiu antes de chegar aqui: esta funcao
// nunca recebe um tenant escolhido pelo cliente sem essa conferencia.
// `tenantRow` evita reler o tenant quando ja veio da autenticacao.
export async function resolverContaDoTenant(
  env: Env,
  tenantId: string,
  chave: { tenantId: string; keyHash: string },
  tenantRow?: TenantRow,
): Promise<TenantResolution> {
  const linha =
    tenantRow && tenantRow.id === tenantId ? tenantRow : await tenantAtivo(env, tenantId);
  if (!linha) {
    return { error: 'account_not_found', status: 404 };
  }
  const keyHash = chave.keyHash;

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
    return motivoSemContaAtiva(env, tenantId);
  }

  return {
    tenant: {
      tenantId,
      unipileAccountId,
      limits: effectiveLimits(linha),
      keyHash,
      keyTenantId: chave.tenantId,
      accountIdEscolhido: null,
    },
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
