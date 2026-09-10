// Link de acesso ao painel do cliente (F2.20/F2.21). Plano B do operador para
// quem perdeu o acesso e ainda nao ha e-mail configurado (RESEND_API_KEY).
//
//   npm run portal:link -- <tenant_id>
//
// Gera um LINK de uso unico (lk_plink_, 256 bits, vale 72h), grava SO o hash
// em portal_tokens e imprime a URL uma vez. Ao abrir, o painel troca o link
// por uma sessao (POST /portal/session) e o link morre. Envie ao cliente por
// canal privado: e o mesmo tipo de link do e-mail de boas-vindas.
import { randomBytes } from 'node:crypto';
import { hashApiKey } from '../src/lib/hash.ts';
import { loadEnv, loadEnvOptional, fail } from './env.ts';

const TTL_MS = 72 * 60 * 60 * 1000;
const DEFAULT_PORTAL_URL = 'https://linkedapi-site.pages.dev/painel.html';

interface TenantRow {
  id: string;
  name: string;
  status: string;
}

function supabaseHeaders(serviceRole: string): Record<string, string> {
  return {
    apikey: serviceRole,
    authorization: `Bearer ${serviceRole}`,
    'content-type': 'application/json',
    prefer: 'return=representation',
  };
}

async function link(tenantId: string): Promise<void> {
  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');
  const portalUrl = (loadEnvOptional('PORTAL_URL') ?? DEFAULT_PORTAL_URL).trim();
  if (!portalUrl.startsWith('https://')) {
    fail('PORTAL_URL precisa comecar com https:// (o link carrega a credencial).');
  }

  const url = new URL(`${supabaseUrl}/rest/v1/tenants`);
  url.searchParams.set('id', `eq.${tenantId}`);
  url.searchParams.set('select', 'id,name,status');
  url.searchParams.set('limit', '1');
  const res = await fetch(url.toString(), { headers: supabaseHeaders(serviceRole) });
  if (!res.ok) {
    fail(`Falha ao buscar o tenant (HTTP ${res.status}).`);
  }
  const tenant = ((await res.json()) as TenantRow[])[0];
  if (!tenant) {
    fail(`Tenant ${tenantId} nao existe.`);
  }
  if (tenant.status !== 'active') {
    fail(`Tenant ${tenantId} esta com status "${tenant.status}", nao "active".`);
  }

  const token = `lk_plink_${randomBytes(32).toString('hex')}`;
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  const ins = await fetch(`${supabaseUrl}/rest/v1/portal_tokens`, {
    method: 'POST',
    headers: supabaseHeaders(serviceRole),
    body: JSON.stringify({
      tenant_id: tenant.id,
      token_hash: await hashApiKey(token),
      kind: 'link',
      status: 'active',
      expires_at: expiresAt,
    }),
  });
  if (!ins.ok) {
    fail(`Falha ao gravar o link do painel (HTTP ${ins.status}). A migration 0009 foi aplicada?`);
  }

  console.log('');
  console.log('Link do painel gerado (uso unico, vale 72h). Envie ao cliente por canal privado:');
  console.log('');
  console.log(`  ${portalUrl}#t=${token}`);
  console.log('');
  console.log(`  tenant: ${tenant.name} (${tenant.id})`);
  console.log(`  expira: ${expiresAt}`);
  console.log('');
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command !== 'link' || !arg) {
    console.error('uso: npm run portal:link -- <tenant_id>');
    process.exit(1);
  }
  await link(arg);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
