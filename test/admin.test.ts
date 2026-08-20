import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../src/types';

// API administrativa (fase 2): sem ADMIN_API_KEY as rotas nem existem (404);
// com a chave errada, 401; leitura agrega tenants/contas/chaves/billing e a
// capacidade de seats contra a conta-mestra.

const ADMIN_KEY = 'admin-key-super-secreta';

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(async (_env: Env, table: string) => {
    if (table === 'tenants') {
      return [
        { id: 'tA', name: 'Tenant A', status: 'active', plan: 'basic', created_at: '2026-08-01' },
      ];
    }
    if (table === 'connected_accounts') {
      return [{ tenant_id: 'tA', unipile_account_id: 'ua-1', status: 'active' }];
    }
    if (table === 'api_keys') {
      return [
        { tenant_id: 'tA', status: 'active', last_used_at: '2026-08-20T10:00:00Z' },
        { tenant_id: 'tA', status: 'revoked', last_used_at: null },
      ];
    }
    if (table === 'billing_subscriptions') {
      return [{ tenant_id: 'tA', status: 'active' }];
    }
    if (table === 'usage_daily') {
      return [{ tenant_id: 'tA', action: 'messages', day: '2026-08-20', count: 12 }];
    }
    return [];
  }),
}));

vi.mock('../src/lib/unipile', () => ({
  listAccounts: vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          items: [
            { id: 'ua-1', type: 'LINKEDIN', name: 'Fulano', sources: [{ status: 'OK' }] },
            { id: 'ua-9', type: 'LINKEDIN', name: 'Solto', sources: [{ status: 'CREDENTIALS' }] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  ),
}));

import app from '../src/index';
import { listAccounts } from '../src/lib/unipile';

function env(adminKey?: string): Env {
  return {
    ENVIRONMENT: 'test',
    UNIPILE_DSN: 'apiX.unipile.com:0000',
    UNIPILE_MASTER_TOKEN: 'master-token-nunca-vaza',
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-nunca-vaza',
    ...(adminKey ? { ADMIN_API_KEY: adminKey } : {}),
  } as Env;
}

function get(path: string, e: Env, key?: string) {
  return app.request(
    path,
    { method: 'GET', headers: key ? { 'X-ADMIN-KEY': key } : {} },
    e,
  );
}

describe('/admin (API do operador)', () => {
  it('sem ADMIN_API_KEY configurada, a superficie nao existe (404)', async () => {
    const res = await get('/admin/tenants', env(), ADMIN_KEY);
    expect(res.status).toBe(404);
  });

  it('chave errada ou ausente: 401', async () => {
    expect((await get('/admin/tenants', env(ADMIN_KEY), 'errada')).status).toBe(401);
    expect((await get('/admin/tenants', env(ADMIN_KEY))).status).toBe(401);
  });

  it('GET /admin/tenants agrega contas, chaves ativas e billing', async () => {
    const res = await get('/admin/tenants', env(ADMIN_KEY), ADMIN_KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([
      {
        tenant_id: 'tA',
        name: 'Tenant A',
        status: 'active',
        plan: 'basic',
        created_at: '2026-08-01',
        accounts: [{ unipile_account_id: 'ua-1', status: 'active' }],
        active_keys: 1,
        last_used_at: '2026-08-20T10:00:00Z',
        billing_status: 'active',
      },
    ]);
  });

  it('GET /admin/usage devolve o historico persistido', async () => {
    const res = await get('/admin/usage?from=2026-08-01&to=2026-08-31', env(ADMIN_KEY), ADMIN_KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ count: number }> };
    expect(body.data[0]?.count).toBe(12);
  });

  it('GET /admin/capacity cruza banco, conta-mestra e teto de seats', async () => {
    const res = await get('/admin/capacity', env(ADMIN_KEY), ADMIN_KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        seat_cap: number;
        db_active_accounts: number;
        master_unavailable: boolean;
        master_accounts_total: number;
        seats_available: number;
      };
    };
    expect(body.data.seat_cap).toBe(10);
    expect(body.data.db_active_accounts).toBe(1);
    expect(body.data.master_unavailable).toBe(false);
    expect(body.data.master_accounts_total).toBe(2);
    expect(body.data.seats_available).toBe(8);
  });

  it('GET /admin/capacity: se a origem falhar, o medidor DIZ que nao sabe (nunca finge zero)', async () => {
    vi.mocked(listAccounts).mockResolvedValueOnce(
      new Response('erro', { status: 503 }),
    );
    const res = await get('/admin/capacity', env(ADMIN_KEY), ADMIN_KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        master_unavailable: boolean;
        master_accounts_total: number | null;
        seats_available: number | null;
      };
    };
    expect(body.data.master_unavailable).toBe(true);
    expect(body.data.master_accounts_total).toBeNull();
    expect(body.data.seats_available).toBeNull();
  });
});
