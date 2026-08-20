import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

// Limites por plano (fase 2, migration 0004): o override do tenant no banco
// vale sobre o default do plano basico, e e resolvido server-side junto com o
// tenant (nunca vem do request).

const KEY_LIMITADO = 'lk_live_key_tenant_limite_2';
const KEY_DEFAULT = 'lk_live_key_tenant_default';

import { hashApiKey } from '../src/lib/tenants';

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(
    async (_env: Env, table: string, filters: Record<string, string>) => {
      const hashLim = await hashApiKey(KEY_LIMITADO);
      const hashDef = await hashApiKey(KEY_DEFAULT);
      if (table === 'api_keys') {
        if (filters.key_hash === `eq.${hashLim}`) return [{ tenant_id: 'tLim' }];
        if (filters.key_hash === `eq.${hashDef}`) return [{ tenant_id: 'tDef' }];
        return [];
      }
      if (table === 'tenants') {
        if (filters.id === 'eq.tLim') {
          // Override do plano: 2 convites/dia.
          return [{ id: 'tLim', daily_invitation_limit: 2 }];
        }
        if (filters.id === 'eq.tDef') {
          // Sem override: defaults do plano basico.
          return [{ id: 'tDef' }];
        }
        return [];
      }
      if (table === 'connected_accounts') {
        if (filters.tenant_id === 'eq.tLim') return [{ unipile_account_id: 'acct-lim' }];
        if (filters.tenant_id === 'eq.tDef') return [{ unipile_account_id: 'acct-def' }];
        return [];
      }
      return [];
    },
  ),
}));

vi.mock('../src/lib/unipile', () => ({
  sendInvitation: vi.fn(
    async () =>
      new Response(JSON.stringify({ invitation_id: 'i1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
}));

import app from '../src/index';
import { sendInvitation } from '../src/lib/unipile';
import { memoryKV } from './helpers';

function baseEnv(): Env {
  return {
    ENVIRONMENT: 'test',
    UNIPILE_DSN: 'apiX.unipile.com:0000',
    UNIPILE_MASTER_TOKEN: 'master-token-nunca-vaza',
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-nunca-vaza',
    RATE_LIMIT: memoryKV(),
  } as Env;
}

function invite(env: Env, apiKey: string) {
  return app.request(
    '/v1/invitations',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({ provider_id: 'p1' }),
    },
    env,
  );
}

beforeEach(() => {
  vi.mocked(sendInvitation).mockClear();
});

describe('limites por plano (override por tenant)', () => {
  it('override do banco vale: 2 convites passam, o 3o leva 429 com o limite do tenant', async () => {
    const env = baseEnv();
    expect((await invite(env, KEY_LIMITADO)).status).toBe(200);
    expect((await invite(env, KEY_LIMITADO)).status).toBe(200);

    const res = await invite(env, KEY_LIMITADO);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { limit: number };
    expect(body.limit).toBe(2); // o limite reportado e o do tenant, nao o default
    expect(sendInvitation).toHaveBeenCalledTimes(2);
  });

  it('tenant sem override usa o default do plano basico (nao o de outro tenant)', async () => {
    const env = baseEnv();
    // O tenant limitado ja estourou; o default continua com a cota propria.
    await invite(env, KEY_LIMITADO);
    await invite(env, KEY_LIMITADO);
    expect((await invite(env, KEY_LIMITADO)).status).toBe(429);
    expect((await invite(env, KEY_DEFAULT)).status).toBe(200);
  });
});
