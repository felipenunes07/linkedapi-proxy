import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

// Rate limiter (Marco 3, regra inviolavel #4): o excesso e cortado com 429 +
// Retry-After, ANTES de chamar a Unipile. Backend KV mockado em memoria.

const KEY = 'lk_live_key_valida';
const KEY_2 = 'lk_live_key_de_outro_tenant';
const ACCT = 'acct-do-tenant';
const ACCT_2 = 'acct-2';

import { hashApiKey } from '../src/lib/tenants';

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(
    async (_env: Env, table: string, filters: Record<string, string>) => {
      const hash = await hashApiKey(KEY);
      const hash2 = await hashApiKey(KEY_2);
      if (table === 'api_keys') {
        if (filters.key_hash === `eq.${hash}`) return [{ tenant_id: 't1' }];
        if (filters.key_hash === `eq.${hash2}`) return [{ tenant_id: 't2' }];
        return [];
      }
      if (table === 'tenants') {
        if (filters.id === 'eq.t1') return [{ id: 't1' }];
        if (filters.id === 'eq.t2') return [{ id: 't2' }];
        return [];
      }
      if (table === 'connected_accounts') {
        if (filters.tenant_id === 'eq.t1') return [{ unipile_account_id: ACCT }];
        if (filters.tenant_id === 'eq.t2') return [{ unipile_account_id: ACCT_2 }];
        return [];
      }
      return [];
    },
  ),
}));

vi.mock('../src/lib/unipile', () => ({
  sendInvitation: vi.fn(
    async () =>
      new Response(JSON.stringify({ object: 'InvitationSent' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
}));

import app from '../src/index';
import { sendInvitation } from '../src/lib/unipile';
import { DAILY_LIMITS } from '../src/middleware/rateLimit';
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

describe('rate limit (Marco 3)', () => {
  beforeEach(() => {
    vi.mocked(sendInvitation).mockClear();
  });

  it('deixa passar ate o limite e corta o excesso com 429 + Retry-After', async () => {
    const env = baseEnv();
    const limit = DAILY_LIMITS.invitations;

    for (let i = 0; i < limit; i++) {
      const res = await invite(env, KEY);
      expect(res.status).toBe(200);
    }

    const res = await invite(env, KEY);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    const bodyText = await res.text();
    expect(bodyText).toContain('rate_limited');

    // Nao chamou a Unipile na request que estourou (limit chamadas, nao limit+1).
    expect(vi.mocked(sendInvitation)).toHaveBeenCalledTimes(limit);
  });

  it('contador e por tenant: um tenant estourado nao afeta o outro', async () => {
    const env = baseEnv();
    const limit = DAILY_LIMITS.invitations;

    for (let i = 0; i < limit; i++) {
      await invite(env, KEY);
    }
    expect((await invite(env, KEY)).status).toBe(429);

    // Outro tenant, mesmo backend KV, contador proprio: ainda passa.
    expect((await invite(env, KEY_2)).status).toBe(200);
  });

  it('request invalido (400) nao consome cota', async () => {
    const env = baseEnv();
    // Muitos corpos invalidos (sem provider_id) nao devem gastar a cota diaria.
    for (let i = 0; i < DAILY_LIMITS.invitations + 5; i++) {
      const res = await app.request(
        '/v1/invitations',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-API-KEY': KEY },
          body: JSON.stringify({ message: 'sem provider_id' }),
        },
        env,
      );
      expect(res.status).toBe(400);
    }
    expect(sendInvitation).not.toHaveBeenCalled();

    // Cota intacta: um convite valido ainda passa.
    expect((await invite(env, KEY)).status).toBe(200);
  });

  it('sem binding de KV, recusa a escrita com 500 (nao segue sem protecao)', async () => {
    const env = { ...baseEnv(), RATE_LIMIT: undefined } as unknown as Env;
    const res = await invite(env, KEY);
    expect(res.status).toBe(500);
    expect(sendInvitation).not.toHaveBeenCalled();
  });
});
