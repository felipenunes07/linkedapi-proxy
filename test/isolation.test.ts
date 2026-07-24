import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

// O teste que prova o negocio (PRD, Marco 2): isolamento multi-tenant.
// A chave do tenant A nunca age pela conta do tenant B, nem passando o
// account_id de B no request.
//
// Estrategia: mockamos a camada de dados (supabaseSelect) para simular dois
// tenants seedados, e mockamos a Unipile (sendMessage) para inspecionar qual
// account_id foi injetado. O resolveTenant REAL roda (hash + cadeia key ->
// tenant -> connected_account + filtro por tenant_id), que e o que queremos
// provar. Sem rede.

const KEY_A = 'lk_live_key_do_tenant_A';
const KEY_B = 'lk_live_key_do_tenant_B';
const ACCT_A = 'acct-A';
const ACCT_B = 'acct-B';

// hashApiKey e a funcao real (nao mockada); usamos para montar o "banco" fake.
import { hashApiKey } from '../src/lib/tenants';

// Mock da camada de dados: responde como o Postgres responderia para o seed.
vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(
    async (_env: Env, table: string, filters: Record<string, string>) => {
      const hashA = await hashApiKey(KEY_A);
      const hashB = await hashApiKey(KEY_B);

      if (table === 'api_keys') {
        if (filters.key_hash === `eq.${hashA}`) return [{ tenant_id: 'tA' }];
        if (filters.key_hash === `eq.${hashB}`) return [{ tenant_id: 'tB' }];
        return [];
      }
      if (table === 'tenants') {
        if (filters.id === 'eq.tA') return [{ id: 'tA' }];
        if (filters.id === 'eq.tB') return [{ id: 'tB' }];
        return [];
      }
      if (table === 'connected_accounts') {
        if (filters.tenant_id === 'eq.tA')
          return [{ unipile_account_id: ACCT_A }];
        if (filters.tenant_id === 'eq.tB')
          return [{ unipile_account_id: ACCT_B }];
        return [];
      }
      return [];
    },
  ),
}));

// Mock da Unipile: nao envia de verdade, so registra a chamada.
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
import { memoryKV } from './helpers';

const env = {
  ENVIRONMENT: 'test',
  UNIPILE_DSN: 'apiX.unipile.com:0000',
  UNIPILE_MASTER_TOKEN: 'master-token-nunca-vaza',
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-nunca-vaza',
  RATE_LIMIT: memoryKV(),
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

function accountUsedInLastCall(): string | undefined {
  const calls = vi.mocked(sendMessage).mock.calls;
  return calls[calls.length - 1]?.[3];
}

describe('isolamento multi-tenant (Marco 2)', () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockClear();
  });

  it('responde no /health (fumaça: app monta)', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('rejeita request sem X-API-KEY com 401', async () => {
    const res = await post(null, { chat_id: 'c1', text: 'oi' });
    expect(res.status).toBe(401);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejeita chave inexistente com 401', async () => {
    const res = await post('chave-que-nao-existe', { chat_id: 'c1', text: 'oi' });
    expect(res.status).toBe(401);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('chave A age pela conta de A; chave B age pela conta de B', async () => {
    const resA = await post(KEY_A, { chat_id: 'c1', text: 'oi' });
    expect(resA.status).toBe(200);
    expect(accountUsedInLastCall()).toBe(ACCT_A);

    const resB = await post(KEY_B, { chat_id: 'c2', text: 'ola' });
    expect(resB.status).toBe(200);
    expect(accountUsedInLastCall()).toBe(ACCT_B);
  });

  it('chave A NAO age pela conta de B mesmo passando account_id de B no corpo', async () => {
    const res = await post(KEY_A, {
      chat_id: 'c1',
      text: 'oi',
      account_id: ACCT_B, // tentativa de agir pela conta de B
      tenant_id: 'tB', // e de se passar por B
    });
    expect(res.status).toBe(200);
    // O account_id injetado tem que ser o de A, resolvido da chave. Nunca o de B.
    expect(accountUsedInLastCall()).toBe(ACCT_A);
    expect(accountUsedInLastCall()).not.toBe(ACCT_B);
  });
});
