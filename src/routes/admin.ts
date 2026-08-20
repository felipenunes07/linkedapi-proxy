import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { supabaseSelect } from '../lib/supabase';
import { secretsEqual } from '../lib/hash';
import { listAccounts } from '../lib/unipile';
import { asRecord, pickString } from '../lib/sanitize';

// API administrativa (operador, fase 2). Leitura apenas; acoes de escrita do
// operador continuam nos scripts (tenant:create, account:link, key:issue...).
//
// Auth: header X-ADMIN-KEY comparado (por hash, timing-safe) com o secret
// ADMIN_API_KEY. Sem o secret configurado, as rotas NAO existem (404): a
// superficie admin nem aparece em producao ate ser explicitamente ligada.
//
//   GET /admin/tenants   tenants + contas + chaves ativas + billing
//   GET /admin/usage     uso persistente (usage_daily), filtro ?from&to
//   GET /admin/capacity  seats: contas ativas no banco vs conta-mestra vs teto

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

interface TenantRow {
  id: string;
  name: string;
  status: string;
  plan: string;
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
  last_used_at: string | null;
}

interface BillingRow {
  tenant_id: string;
  status: string;
}

interface UsageRow {
  tenant_id: string;
  action: string;
  day: string;
  count: number;
}

const DEFAULT_SEAT_CAP = 10;

export const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

admin.use('*', async (c: Ctx, next) => {
  const expected = c.env.ADMIN_API_KEY;
  if (!expected) {
    // Admin desligado: nao anunciar que a rota existe.
    return c.json({ error: 'not_found' }, 404);
  }
  const provided = c.req.header('X-ADMIN-KEY');
  if (!provided || !(await secretsEqual(provided, expected))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

admin.get('/tenants', async (c) => {
  const [tenants, accounts, keys, billing] = await Promise.all([
    supabaseSelect<TenantRow>(c.env, 'tenants', {
      select: 'id,name,status,plan,created_at',
      order: 'created_at.asc',
    }),
    supabaseSelect<AccountRow>(c.env, 'connected_accounts', {
      select: 'tenant_id,unipile_account_id,status',
    }),
    supabaseSelect<KeyRow>(c.env, 'api_keys', {
      select: 'tenant_id,status,last_used_at',
    }),
    supabaseSelect<BillingRow>(c.env, 'billing_subscriptions', {
      select: 'tenant_id,status',
    }),
  ]);

  const data = tenants.map((t) => {
    const tenantKeys = keys.filter((k) => k.tenant_id === t.id);
    const lastUsed = tenantKeys
      .map((k) => k.last_used_at)
      .filter((v): v is string => v !== null)
      .sort()
      .at(-1);
    return {
      tenant_id: t.id,
      name: t.name,
      status: t.status,
      plan: t.plan,
      created_at: t.created_at,
      accounts: accounts
        .filter((a) => a.tenant_id === t.id)
        .map((a) => ({ unipile_account_id: a.unipile_account_id, status: a.status })),
      active_keys: tenantKeys.filter((k) => k.status === 'active').length,
      last_used_at: lastUsed ?? null,
      billing_status: billing.find((b) => b.tenant_id === t.id)?.status ?? null,
    };
  });

  return c.json({ ok: true, data });
});

admin.get('/usage', async (c) => {
  const filters: Record<string, string> = {
    select: 'tenant_id,action,day,count',
    order: 'day.desc',
  };
  // Datas so no formato YYYY-MM-DD; qualquer outra coisa e ignorada (o formato
  // fechado tambem impede injetar operador PostgREST no valor).
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = c.req.query('from');
  const to = c.req.query('to');
  const fromOk = from && dateRe.test(from) ? from : null;
  const toOk = to && dateRe.test(to) ? to : null;
  if (fromOk && toOk) {
    filters.and = `(day.gte.${fromOk},day.lte.${toOk})`;
  } else if (fromOk) {
    filters.day = `gte.${fromOk}`;
  } else if (toOk) {
    filters.day = `lte.${toOk}`;
  }
  const rows = await supabaseSelect<UsageRow>(c.env, 'usage_daily', filters);
  return c.json({ ok: true, data: rows });
});

admin.get('/capacity', async (c) => {
  const parsedCap = Number(c.env.SEAT_CAP);
  const seatCap =
    Number.isFinite(parsedCap) && parsedCap >= 0 ? parsedCap : DEFAULT_SEAT_CAP;

  const dbAccounts = await supabaseSelect<AccountRow>(
    c.env,
    'connected_accounts',
    { select: 'tenant_id,unipile_account_id,status' },
  );
  const dbActive = dbAccounts.filter((a) => a.status === 'active').length;

  // Visao da conta-mestra (fonte da verdade de custo): tudo que esta conectado
  // la ocupa slot, vinculado a tenant ou nao. Se a origem nao responder, o
  // medidor DIZ que nao sabe (nunca finge zero: e o numero que decide se da
  // para vender mais um seat).
  let masterAccounts: Array<{ id: string | null; status: string | null }> | null =
    null;
  try {
    const res = await listAccounts(c.env);
    if (res.ok) {
      const body = asRecord(await res.json());
      const items = Array.isArray(body.items) ? body.items : [];
      masterAccounts = items.map((item) => {
        const account = asRecord(item);
        const sources = Array.isArray(account.sources) ? account.sources : [];
        return {
          id: pickString(account, 'id'),
          status: pickString(asRecord(sources[0]), 'status'),
        };
      });
    }
  } catch {
    // origem inalcancavel: masterAccounts continua null
  }

  return c.json({
    ok: true,
    data: {
      seat_cap: seatCap,
      db_active_accounts: dbActive,
      master_unavailable: masterAccounts === null,
      master_accounts_total: masterAccounts?.length ?? null,
      master_accounts: masterAccounts ?? [],
      seats_available:
        masterAccounts === null
          ? null
          : Math.max(0, seatCap - masterAccounts.length),
    },
  });
});
