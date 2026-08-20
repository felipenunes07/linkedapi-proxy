// Billing via Asaas (fase 2). Script standalone do operador, como keys.ts.
//
//   npm run billing:subscribe -- <tenant_id> "<nome>" <cpf_cnpj> <email>
//     cria o cliente + assinatura Pix mensal no Asaas e grava o vinculo em
//     billing_subscriptions. O valor vem de PLAN_PRICE_BRL (default 57).
//   npm run billing:status
//     lista as assinaturas e seus status.
//
// Segredos: ASAAS_API_KEY em .dev.vars/env, nunca logada. Producao usa
// https://api.asaas.com/v3; para testar, aponte ASAAS_BASE_URL para o sandbox
// (https://api-sandbox.asaas.com/v3).
//
// O webhook de cobranca (POST {PUBLIC_BASE_URL}/hooks/billing, com o token
// ASAAS_HOOK_TOKEN no header asaas-access-token) e configurado no painel do
// Asaas; ver docs/pendencias.md.
import { loadEnv, loadEnvOptional, fail } from './env.ts';

const DEFAULT_PRICE_BRL = 57;

function asaasBase(): string {
  return (loadEnvOptional('ASAAS_BASE_URL') ?? 'https://api.asaas.com/v3').replace(/\/+$/, '');
}

function asaasHeaders(): Record<string, string> {
  return {
    access_token: loadEnv('ASAAS_API_KEY'),
    'content-type': 'application/json',
    accept: 'application/json',
  };
}

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
}

interface AsaasCustomer {
  id?: string;
}

interface AsaasSubscription {
  id?: string;
  status?: string;
}

interface BillingRow {
  tenant_id: string;
  asaas_subscription_id: string;
  status: string;
  updated_at: string;
}

async function fetchTenant(tenantId: string): Promise<TenantRow> {
  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');
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
  return tenant;
}

async function subscribe(
  tenantId: string,
  nome: string,
  cpfCnpj: string,
  email: string,
): Promise<void> {
  const tenant = await fetchTenant(tenantId);
  const price = Number(loadEnvOptional('PLAN_PRICE_BRL') ?? DEFAULT_PRICE_BRL);
  if (!Number.isFinite(price) || price <= 0) {
    fail('PLAN_PRICE_BRL invalido.');
  }

  // 1. Cliente no Asaas.
  const customerRes = await fetch(`${asaasBase()}/customers`, {
    method: 'POST',
    headers: asaasHeaders(),
    body: JSON.stringify({
      name: nome,
      cpfCnpj,
      email,
      externalReference: tenant.id,
    }),
  });
  if (!customerRes.ok) {
    fail(`Falha ao criar o cliente no Asaas (HTTP ${customerRes.status}).`);
  }
  const customer = (await customerRes.json()) as AsaasCustomer;
  if (!customer.id) {
    fail('Asaas nao retornou o id do cliente.');
  }

  // 2. Assinatura Pix mensal. Primeiro vencimento em 3 dias.
  const nextDueDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const subRes = await fetch(`${asaasBase()}/subscriptions`, {
    method: 'POST',
    headers: asaasHeaders(),
    body: JSON.stringify({
      customer: customer.id,
      billingType: 'PIX',
      value: price,
      nextDueDate,
      cycle: 'MONTHLY',
      description: `LinkedAPI, 1 seat (${tenant.name})`,
      externalReference: tenant.id,
    }),
  });
  if (!subRes.ok) {
    fail(`Falha ao criar a assinatura no Asaas (HTTP ${subRes.status}).`);
  }
  const subscription = (await subRes.json()) as AsaasSubscription;
  if (!subscription.id) {
    fail('Asaas nao retornou o id da assinatura.');
  }

  // 3. Vinculo no banco (upsert por tenant).
  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');
  const upsertRes = await fetch(
    `${supabaseUrl}/rest/v1/billing_subscriptions?on_conflict=tenant_id`,
    {
      method: 'POST',
      headers: {
        ...supabaseHeaders(serviceRole),
        prefer: 'return=representation,resolution=merge-duplicates',
      },
      body: JSON.stringify({
        tenant_id: tenant.id,
        asaas_customer_id: customer.id,
        asaas_subscription_id: subscription.id,
        status: 'pending',
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!upsertRes.ok) {
    fail(
      `Assinatura criada no Asaas (${subscription.id}), mas falhou ao gravar no banco (HTTP ${upsertRes.status}). Grave na mao.`,
    );
  }

  console.log('');
  console.log('Assinatura criada:');
  console.log(`  tenant:        ${tenant.name} (${tenant.id})`);
  console.log(`  valor:         R$ ${price}/mes (Pix, primeiro vencimento ${nextDueDate})`);
  console.log(`  subscription:  ${subscription.id}`);
  console.log('');
  console.log('Pagamento confirmado ativa; atraso PAUSA as contas do tenant');
  console.log('(via POST /hooks/billing; configure o webhook no painel do Asaas).');
}

async function status(): Promise<void> {
  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');
  const url = new URL(`${supabaseUrl}/rest/v1/billing_subscriptions`);
  url.searchParams.set('select', 'tenant_id,asaas_subscription_id,status,updated_at');
  url.searchParams.set('order', 'updated_at.desc');
  const res = await fetch(url.toString(), { headers: supabaseHeaders(serviceRole) });
  if (!res.ok) {
    fail(`Falha ao listar (HTTP ${res.status}).`);
  }
  const rows = (await res.json()) as BillingRow[];
  if (rows.length === 0) {
    console.log('Nenhuma assinatura. Crie com: npm run billing:subscribe -- <tenant_id> "<nome>" <cpf_cnpj> <email>');
    return;
  }
  for (const row of rows) {
    console.log(
      `${row.tenant_id}  ${row.status.padEnd(8)}  ${row.asaas_subscription_id}  (${row.updated_at})`,
    );
  }
}

function usage(): never {
  console.error('uso:');
  console.error('  npm run billing:subscribe -- <tenant_id> "<nome>" <cpf_cnpj> <email>');
  console.error('  npm run billing:status');
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'subscribe') {
    const [tenantId, nome, cpfCnpj, email] = args;
    if (!tenantId || !nome || !cpfCnpj || !email) {
      usage();
    }
    await subscribe(tenantId, nome, cpfCnpj, email);
  } else if (command === 'status') {
    await status();
  } else {
    usage();
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
