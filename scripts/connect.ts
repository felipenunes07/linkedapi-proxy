// Geracao de links de auto-conexao (Marco 4, hosted auth white-label).
// Script Node standalone, como keys.ts: o operador roda no terminal e envia o
// link ao cliente. O cliente conecta o proprio LinkedIn no wizard, sem nunca
// tocar (nem ver) o painel da Unipile.
//
//   npm run connect:link      -- <tenant_id>   link para conectar conta NOVA
//   npm run connect:reconnect -- <tenant_id>   link para RECONECTAR a conta do tenant
//
// Fluxo de seguranca (espelha src/routes/connect.ts):
//   - gera um token opaco (256 bits) de uso unico com validade curta;
//   - grava SO o hash em connect_tokens, vinculado ao tenant;
//   - o token vai no campo `name` do link; a Unipile o devolve no notify, e o
//     callback do Worker (POST {PUBLIC_BASE_URL}/hooks/connect) usa o token
//     para gravar o account_id no tenant CERTO.
//   - Recruiter/Sales Navigator/paginas de organizacao desabilitados (D7).
//
// Segredos (UNIPILE_*, SUPABASE_*) vem de .dev.vars/env e nunca sao logados.
import { randomBytes } from 'node:crypto';
import { hashApiKey } from '../src/lib/hash.ts';
import { loadEnv, loadEnvOptional, fail } from './env.ts';

// Validade do link e do token. Curta de proposito: o link e para ser usado na
// hora (a doc da hosted auth recomenda minutos a poucas horas).
const LINK_TTL_MS = 2 * 60 * 60 * 1000; // 2 horas

interface TenantRow {
  id: string;
  name: string;
  status: string;
}

interface ConnectedAccountRow {
  unipile_account_id: string;
  status: string;
}

interface HostedAuthResponse {
  url?: string;
}

function supabaseHeaders(serviceRole: string): Record<string, string> {
  return {
    apikey: serviceRole,
    authorization: `Bearer ${serviceRole}`,
    'content-type': 'application/json',
    prefer: 'return=representation',
  };
}

async function fetchTenant(tenantId: string): Promise<TenantRow> {
  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');

  const url = new URL(`${supabaseUrl}/rest/v1/tenants`);
  url.searchParams.set('id', `eq.${tenantId}`);
  url.searchParams.set('select', 'id,name,status');
  url.searchParams.set('limit', '1');

  const res = await fetch(url.toString(), {
    headers: supabaseHeaders(serviceRole),
  });
  if (!res.ok) {
    fail(`Falha ao buscar o tenant (HTTP ${res.status}).`);
  }
  const rows = (await res.json()) as TenantRow[];
  const tenant = rows[0];
  if (!tenant) {
    fail(`Tenant ${tenantId} nao existe.`);
  }
  if (tenant.status !== 'active') {
    fail(`Tenant ${tenantId} esta com status "${tenant.status}", nao "active".`);
  }
  return tenant;
}

async function fetchConnectedAccount(
  tenantId: string,
): Promise<ConnectedAccountRow> {
  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');

  const url = new URL(`${supabaseUrl}/rest/v1/connected_accounts`);
  url.searchParams.set('tenant_id', `eq.${tenantId}`);
  url.searchParams.set('provider', 'eq.linkedin');
  // Conta pausada (ex.: inadimplencia) nao gera link de reconexao: a pausa e
  // decisao de negocio e nao se desfaz pelo wizard.
  url.searchParams.set('status', 'in.(active,disconnected)');
  url.searchParams.set('select', 'unipile_account_id,status');
  url.searchParams.set('order', 'created_at.desc');
  url.searchParams.set('limit', '1');

  const res = await fetch(url.toString(), {
    headers: supabaseHeaders(serviceRole),
  });
  if (!res.ok) {
    fail(`Falha ao buscar a conta do tenant (HTTP ${res.status}).`);
  }
  const rows = (await res.json()) as ConnectedAccountRow[];
  const account = rows[0];
  if (!account) {
    fail(
      `Tenant ${tenantId} nao tem conta conectada. Use connect:link para conectar uma nova.`,
    );
  }
  return account;
}

async function insertConnectToken(
  tenantId: string,
  tokenHash: string,
  purpose: 'create' | 'reconnect',
  expiresAtIso: string,
): Promise<void> {
  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');

  const res = await fetch(`${supabaseUrl}/rest/v1/connect_tokens`, {
    method: 'POST',
    headers: supabaseHeaders(serviceRole),
    body: JSON.stringify({
      tenant_id: tenantId,
      token_hash: tokenHash,
      purpose,
      status: 'pending',
      expires_at: expiresAtIso,
    }),
  });
  if (!res.ok) {
    fail(`Falha ao gravar o connect_token (HTTP ${res.status}).`);
  }
}

async function requestHostedAuthLink(
  body: Record<string, unknown>,
): Promise<string> {
  const dsn = loadEnv('UNIPILE_DSN');
  const masterToken = loadEnv('UNIPILE_MASTER_TOKEN');

  const res = await fetch(`https://${dsn}/api/v1/hosted/accounts/link`, {
    method: 'POST',
    headers: {
      'X-API-KEY': masterToken,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Sem corpo cru: pode carregar detalhe de infra.
    fail(`Falha ao gerar o link de conexao (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as HostedAuthResponse;
  if (!data.url) {
    fail('Resposta da geracao de link nao trouxe a URL.');
  }
  return data.url;
}

async function generateLink(
  tenantId: string,
  purpose: 'create' | 'reconnect',
): Promise<void> {
  const dsn = loadEnv('UNIPILE_DSN');
  const publicBaseUrl = loadEnv('PUBLIC_BASE_URL').replace(/\/+$/, '');
  if (!publicBaseUrl.startsWith('https://')) {
    // O notify carrega o token em claro no corpo; nunca por http.
    fail('PUBLIC_BASE_URL precisa comecar com https://');
  }
  const successUrl = loadEnvOptional('CONNECT_SUCCESS_REDIRECT_URL');
  const failureUrl = loadEnvOptional('CONNECT_FAILURE_REDIRECT_URL');

  const tenant = await fetchTenant(tenantId);

  // Token opaco de uso unico: mesmo formato de entropia das API keys (256 bits).
  // So o hash e persistido; o claro vive apenas dentro do link gerado.
  const token = `lk_conn_${randomBytes(32).toString('hex')}`;
  const tokenHash = await hashApiKey(token);
  const expiresAtIso = new Date(Date.now() + LINK_TTL_MS).toISOString();

  await insertConnectToken(tenant.id, tokenHash, purpose, expiresAtIso);

  const body: Record<string, unknown> = {
    type: purpose === 'create' ? 'create' : 'reconnect',
    api_url: `https://${dsn}`,
    expiresOn: expiresAtIso,
    name: token,
    notify_url: `${publicBaseUrl}/hooks/connect`,
    // Uso unico explicito: nunca reaproveitar o mesmo link para outra conta.
    single_use: true,
    // D7: sem Recruiter/Sales Navigator/caixas de organizacao. Menos suporte,
    // menos problema de sessao.
    disabled_features: [
      'linkedin_recruiter',
      'linkedin_sales_navigator',
      'linkedin_organizations_mailboxes',
    ],
  };
  if (purpose === 'create') {
    body.providers = ['LINKEDIN'];
  } else {
    const account = await fetchConnectedAccount(tenant.id);
    body.reconnect_account = account.unipile_account_id;
  }
  if (successUrl) {
    body.success_redirect_url = successUrl;
    body.bypass_success_screen = true;
  }
  if (failureUrl) {
    body.failure_redirect_url = failureUrl;
  }

  const url = await requestHostedAuthLink(body);

  console.log('');
  console.log(
    purpose === 'create'
      ? 'Link de conexao gerado. Envie ao cliente; ele conecta o proprio LinkedIn:'
      : 'Link de RECONEXAO gerado. Envie ao cliente para restaurar a sessao:',
  );
  console.log('');
  console.log(`  ${url}`);
  console.log('');
  console.log(`  tenant:   ${tenant.name} (${tenant.id})`);
  console.log(`  expira:   ${expiresAtIso}`);
  console.log('');
  console.log(
    'Quando a conexao concluir, o callback grava a conta automaticamente no tenant.',
  );
}

function usage(): never {
  console.error('uso:');
  console.error('  npm run connect:link      -- <tenant_id>');
  console.error('  npm run connect:reconnect -- <tenant_id>');
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command === 'link') {
    if (!arg) {
      fail('connect:link precisa do <tenant_id>.');
    }
    await generateLink(arg, 'create');
  } else if (command === 'reconnect') {
    if (!arg) {
      fail('connect:reconnect precisa do <tenant_id>.');
    }
    await generateLink(arg, 'reconnect');
  } else {
    usage();
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
