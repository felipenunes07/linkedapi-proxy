// Administracao de tenants (operador, standalone como keys.ts).
//
//   npm run tenant:create -- "<nome>"                          cria tenant, imprime o id
//   npm run tenant:list                                        tenants + contas + chaves
//   npm run account:link  -- <tenant_id> <unipile_account_id>  vincula conta manualmente
//
// account:link e o caminho manual/seed (o caminho normal de cliente e o
// connect:link do Marco 4). Antes de gravar, confirma na Unipile que a conta
// existe na conta-mestra e e LINKEDIN, e respeita o unique do banco (uma conta
// nunca aponta para dois tenants).
import { loadEnv, fail } from './env.ts';

function supabaseHeaders(serviceRole: string): Record<string, string> {
  return {
    apikey: serviceRole,
    authorization: `Bearer ${serviceRole}`,
    'content-type': 'application/json',
    prefer: 'return=representation',
  };
}

interface TenantRow {
  id: string;
  name: string;
  status: string;
  created_at: string;
}

interface AccountRow {
  tenant_id: string;
  unipile_account_id: string;
  status: string;
}

interface KeyRow {
  tenant_id: string;
  status: string;
}

async function createTenant(name: string): Promise<void> {
  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');

  const res = await fetch(`${supabaseUrl}/rest/v1/tenants`, {
    method: 'POST',
    headers: supabaseHeaders(serviceRole),
    body: JSON.stringify({ name, status: 'active' }),
  });
  if (!res.ok) {
    fail(`Falha ao criar o tenant (HTTP ${res.status}).`);
  }
  const rows = (await res.json()) as TenantRow[];
  const tenant = rows[0];
  if (!tenant) {
    fail('Insercao nao retornou a linha criada.');
  }

  console.log('');
  console.log('Tenant criado:');
  console.log(`  tenant_id: ${tenant.id}`);
  console.log(`  name:      ${tenant.name}`);
  console.log('');
  console.log('Proximos passos:');
  console.log(`  conectar LinkedIn (cliente):  npm run connect:link -- ${tenant.id}`);
  console.log(`  ou vincular conta na mao:     npm run account:link -- ${tenant.id} <unipile_account_id>`);
  console.log(`  emitir chave:                 npm run key:issue -- ${tenant.id}`);
}

async function listTenants(): Promise<void> {
  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');
  const headers = supabaseHeaders(serviceRole);

  async function q<T>(pathAndQuery: string): Promise<T[]> {
    const res = await fetch(`${supabaseUrl}/rest/v1/${pathAndQuery}`, { headers });
    if (!res.ok) {
      fail(`Falha ao listar (HTTP ${res.status}).`);
    }
    return (await res.json()) as T[];
  }

  const tenants = await q<TenantRow>(
    'tenants?select=id,name,status,created_at&order=created_at',
  );
  const accounts = await q<AccountRow>(
    'connected_accounts?select=tenant_id,unipile_account_id,status',
  );
  const keys = await q<KeyRow>('api_keys?select=tenant_id,status');

  if (tenants.length === 0) {
    console.log('Nenhum tenant. Crie com: npm run tenant:create -- "<nome>"');
    return;
  }
  for (const t of tenants) {
    const accs = accounts.filter((a) => a.tenant_id === t.id);
    const activeKeys = keys.filter(
      (k) => k.tenant_id === t.id && k.status === 'active',
    ).length;
    console.log('');
    console.log(`${t.name}  [${t.status}]`);
    console.log(`  tenant_id: ${t.id}`);
    console.log(`  chaves ativas: ${activeKeys}`);
    if (accs.length === 0) {
      console.log('  conta: NENHUMA (chave valida vai dar 401 ate conectar)');
    }
    for (const a of accs) {
      console.log(`  conta: ${a.unipile_account_id}  [${a.status}]`);
    }
  }
  console.log('');
}

async function linkAccount(
  tenantId: string,
  unipileAccountId: string,
): Promise<void> {
  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');
  const dsn = loadEnv('UNIPILE_DSN');
  const masterToken = loadEnv('UNIPILE_MASTER_TOKEN');

  // Guard: a conta existe na NOSSA conta-mestra e e LinkedIn?
  const accountRes = await fetch(
    `https://${dsn}/api/v1/accounts/${encodeURIComponent(unipileAccountId)}`,
    { headers: { 'X-API-KEY': masterToken, accept: 'application/json' } },
  );
  if (!accountRes.ok) {
    fail(
      `Conta ${unipileAccountId} nao encontrada na conta-mestra (HTTP ${accountRes.status}).`,
    );
  }
  const account = (await accountRes.json()) as { type?: string };
  if (account.type !== 'LINKEDIN') {
    fail(`Conta ${unipileAccountId} nao e LINKEDIN (type=${account.type}).`);
  }

  const res = await fetch(`${supabaseUrl}/rest/v1/connected_accounts`, {
    method: 'POST',
    headers: supabaseHeaders(serviceRole),
    body: JSON.stringify({
      tenant_id: tenantId,
      unipile_account_id: unipileAccountId,
      provider: 'linkedin',
      status: 'active',
    }),
  });
  if (res.status === 409) {
    fail(
      'Conta ja vinculada (o unique do banco impede duas linhas). Veja npm run tenant:list.',
    );
  }
  if (!res.ok) {
    fail(`Falha ao vincular (HTTP ${res.status}). Verifique o tenant_id.`);
  }

  console.log('');
  console.log(`Conta ${unipileAccountId} vinculada ao tenant ${tenantId} (active).`);
  console.log(`Emitir chave: npm run key:issue -- ${tenantId}`);
}

function usage(): never {
  console.error('uso:');
  console.error('  npm run tenant:create -- "<nome>"');
  console.error('  npm run tenant:list');
  console.error('  npm run account:link  -- <tenant_id> <unipile_account_id>');
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, arg1, arg2] = process.argv.slice(2);
  if (command === 'create') {
    if (!arg1) {
      fail('tenant:create precisa do <nome>.');
    }
    await createTenant(arg1);
  } else if (command === 'list') {
    await listTenants();
  } else if (command === 'link-account') {
    if (!arg1 || !arg2) {
      fail('account:link precisa de <tenant_id> e <unipile_account_id>.');
    }
    await linkAccount(arg1, arg2);
  } else {
    usage();
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
