import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

// Validacao do handler POST /v1/messages (Marco 2). Auth agora vem do banco;
// mockamos a camada de dados com um unico tenant e a Unipile.

const KEY = 'lk_live_key_valida';
const ACCT = 'acct-do-tenant';

import { hashApiKey } from '../src/lib/tenants';

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(
    async (_env: Env, table: string, filters: Record<string, string>) => {
      const hash = await hashApiKey(KEY);
      if (table === 'api_keys')
        return filters.key_hash === `eq.${hash}` ? [{ tenant_id: 't1' }] : [];
      if (table === 'connected_accounts')
        return filters.tenant_id === 'eq.t1'
          ? [{ unipile_account_id: ACCT }]
          : [];
      return [];
    },
  ),
}));

vi.mock('../src/lib/unipile', () => ({
  sendMessage: vi.fn(
    async () =>
      new Response(JSON.stringify({ object: 'MessageSent', message_id: 'm1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
}));

import app from '../src/index';
import { sendMessage } from '../src/lib/unipile';

const env = {
  ENVIRONMENT: 'test',
  UNIPILE_DSN: 'apiX.unipile.com:0000',
  UNIPILE_MASTER_TOKEN: 'master-token-nunca-vaza',
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-nunca-vaza',
} as Env;

function post(apiKey: string | null, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey !== null) headers['X-API-KEY'] = apiKey;
  return app.request(
    '/v1/messages',
    { method: 'POST', headers, body: JSON.stringify(body) },
    env,
  );
}

describe('POST /v1/messages (validacao)', () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockClear();
  });

  it('caminho feliz: 200 e envia pela conta do tenant', async () => {
    const res = await post(KEY, { chat_id: 'c1', text: 'oi' });
    expect(res.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      'c1',
      'oi',
      ACCT,
    );
  });

  it('sem chat_id responde 400 (valida antes de chamar a Unipile)', async () => {
    const res = await post(KEY, { text: 'oi' });
    expect(res.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sem text responde 400', async () => {
    const res = await post(KEY, { chat_id: 'c1' });
    expect(res.status).toBe(400);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
