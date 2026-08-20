import type { Env } from '../types';

// Cliente minimo do Supabase via PostgREST. So o servidor fala com o banco, e
// so com a SERVICE ROLE key (segredo). A service role CONTORNA a RLS, entao
// toda query aqui ainda filtra por tenant_id explicitamente (defesa em
// profundidade): a RLS e a rede de seguranca, nao a unica barreira.

// SELECT tipado. `filters` sao pares no formato PostgREST (ex.: 'eq.<valor>').
// Ex.: supabaseSelect(env, 'api_keys', { key_hash: `eq.${hash}`, select: 'tenant_id' })
export async function supabaseSelect<T>(
  env: Env,
  table: string,
  filters: Record<string, string>,
): Promise<T[]> {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(filters)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString(), {
    headers: {
      // A service role key vai como apikey e como Bearer. Segredo: nunca logar.
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      accept: 'application/json',
    },
  });

  if (!res.ok) {
    // Nao repassar corpo cru: pode carregar detalhe de infra. So o status.
    throw new Error(`supabase_select_failed:${res.status}`);
  }

  return (await res.json()) as T[];
}

// INSERT tipado. Retorna as linhas criadas (Prefer: return=representation).
// Usado pelo callback da auto-conexao (Marco 4) para gravar connected_accounts.
// Mesma disciplina do select: quem chama e responsavel por passar o tenant_id
// correto (aqui, o resolvido do connect_token, nunca de input do cliente).
export async function supabaseInsert<T>(
  env: Env,
  table: string,
  row: Record<string, unknown>,
): Promise<T[]> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    // 409 = violacao de unique (ex.: conta ja vinculada). Sem corpo cru.
    throw new Error(`supabase_insert_failed:${res.status}`);
  }

  return (await res.json()) as T[];
}

// RPC (funcao Postgres via PostgREST). Usada para operacoes que precisam ser
// atomicas no banco (ex.: increment_usage). Mesma disciplina de segredo/erro.
export async function supabaseRpc(
  env: Env,
  fn: string,
  args: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    throw new Error(`supabase_rpc_failed:${res.status}`);
  }
}

// UPDATE (PATCH) tipado, com filtros PostgREST. Retorna as linhas alteradas.
export async function supabaseUpdate<T>(
  env: Env,
  table: string,
  filters: Record<string, string>,
  patch: Record<string, unknown>,
): Promise<T[]> {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(filters)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify(patch),
  });

  if (!res.ok) {
    throw new Error(`supabase_update_failed:${res.status}`);
  }

  return (await res.json()) as T[];
}
