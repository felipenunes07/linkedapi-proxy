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
