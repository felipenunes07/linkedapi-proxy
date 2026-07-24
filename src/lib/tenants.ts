import type { Env, Tenant } from '../types';

// Resolucao de tenant e account_id. Esta e a fronteira de seguranca #1:
// a unica origem legitima do account_id e a cadeia
//   API key -> api_keys.tenant_id -> connected_accounts.unipile_account_id
// NUNCA o request do cliente.

// TODO(Marco 2): implementar de verdade contra o Supabase.
// - hashear a apiKey recebida e buscar em api_keys (status ativo)
// - carregar connected_accounts do tenant (provider = 'linkedin', ativo)
// - retornar null se a chave for invalida/revogada
export async function resolveTenant(
  _env: Env,
  _apiKey: string,
): Promise<Tenant | null> {
  throw new Error('resolveTenant nao implementado (ver spec Marco 2)');
}

// Hash da API key. Guardamos apenas o hash; comparamos por hash.
export async function hashApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
