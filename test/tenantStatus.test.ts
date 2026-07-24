import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

// Follow-up do Marco 2: tenants.status passa a ser checado na resolucao.
// Uma chave valida cujo tenant foi suspenso (status != active) nao age: 401.
// Simulamos o banco retornando o tenant como inativo (query por status=active
// nao encontra nada).

const KEY = 'lk_live_key_de_tenant_suspenso';
const ACCT = 'acct-do-tenant';

import { hashApiKey } from '../src/lib/tenants';

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(
    async (_env: Env, table: string, filters: Record<string, string>) => {
      const hash = await hashApiKey(KEY);
      // A chave existe e aponta para o tenant...
      if (table === 'api_keys')
        return filters.key_hash === `eq.${hash}` ? [{ tenant_id: 't1' }] : [];
      // ...mas o tenant NAO esta ativo: a query por status=active nao acha nada.
      if (table === 'tenants') return [];
      // Nao deve nem chegar aqui, mas se chegar, a conta existiria.
      if (table === 'connected_accounts')
        return filters.tenant_id === 'eq.t1'
          ? [{ unipile_account_id: ACCT }]
          : [];
      return [];
    },
  ),
}));

vi.mock('../src/lib/unipile', () => ({
  sendMessage: vi.fn(),
}));

import app from '../src/index';
import { sendMessage } from '../src/lib/unipile';
import { supabaseSelect } from '../src/lib/supabase';
import { memoryKV } from './helpers';

const env = {
  ENVIRONMENT: 'test',
  UNIPILE_DSN: 'apiX.unipile.com:0000',
  UNIPILE_MASTER_TOKEN: 'master-token-nunca-vaza',
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-nunca-vaza',
  RATE_LIMIT: memoryKV(),
} as Env;

describe('resolucao de tenant: status suspenso', () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockClear();
    vi.mocked(supabaseSelect).mockClear();
  });

  it('chave de tenant suspenso responde 401 e nao chama a Unipile', async () => {
    const res = await app.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-API-KEY': KEY },
        body: JSON.stringify({ chat_id: 'c1', text: 'oi' }),
      },
      env,
    );
    expect(res.status).toBe(401);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('nem chega a consultar connected_accounts se o tenant esta inativo', async () => {
    await app.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-API-KEY': KEY },
        body: JSON.stringify({ chat_id: 'c1', text: 'oi' }),
      },
      env,
    );
    const tablesQueried = vi
      .mocked(supabaseSelect)
      .mock.calls.map((call) => call[1]);
    expect(tablesQueried).toContain('api_keys');
    expect(tablesQueried).toContain('tenants');
    expect(tablesQueried).not.toContain('connected_accounts');
  });
});
