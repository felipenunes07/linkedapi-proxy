// Bindings do Worker (secrets + vars). Ver .dev.vars.example.
// IMPORTANT: UNIPILE_* e SUPABASE_SERVICE_ROLE_KEY sao segredos: so no servidor.
export interface Env {
  // Vars nao secretas
  ENVIRONMENT: string;

  // Segredos (Worker secrets / .dev.vars) - nunca expor ao cliente
  UNIPILE_DSN: string;
  UNIPILE_MASTER_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // Rate limit (Marco 3) - descomentar o binding no wrangler.jsonc
  // RATE_LIMIT: KVNamespace;
}

// Tenant resolvido a partir da API key autenticada.
export interface Tenant {
  tenantId: string;
  // account_id da conta-mestra Unipile vinculada a este tenant.
  // Resolvido SEMPRE no servidor, nunca vindo do request.
  unipileAccountId: string;
}

// Variaveis por-request do Hono (context.var).
export interface Variables {
  tenant: Tenant;
}
