import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

// Endpoints novos do Marco 3: POST /v1/invitations e GET /v1/chats.
// Prova: caminho feliz, validacao, e isolamento (account_id sempre do tenant,
// nunca do request). Mesma estrategia dos outros testes: data layer e Unipile
// mockados, resolveTenant real roda.

const KEY_A = 'lk_live_key_do_tenant_A';
const KEY_B = 'lk_live_key_do_tenant_B';
const ACCT_A = 'acct-A';
const ACCT_B = 'acct-B';

import { hashApiKey } from '../src/lib/tenants';

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
        if (filters.tenant_id === 'eq.tA') return [{ unipile_account_id: ACCT_A }];
        if (filters.tenant_id === 'eq.tB') return [{ unipile_account_id: ACCT_B }];
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
  listChats: vi.fn(
    async () =>
      new Response(JSON.stringify({ object: 'ChatList', items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
}));

import app from '../src/index';
import { sendInvitation, listChats } from '../src/lib/unipile';
import { memoryKV } from './helpers';

const env = {
  ENVIRONMENT: 'test',
  UNIPILE_DSN: 'apiX.unipile.com:0000',
  UNIPILE_MASTER_TOKEN: 'master-token-nunca-vaza',
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-nunca-vaza',
  RATE_LIMIT: memoryKV(),
} as Env;

function postInvite(apiKey: string, body: unknown) {
  return app.request(
    '/v1/invitations',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify(body),
    },
    env,
  );
}

function getChats(apiKey: string, query = '') {
  return app.request(
    `/v1/chats${query}`,
    { method: 'GET', headers: { 'X-API-KEY': apiKey } },
    env,
  );
}

describe('POST /v1/invitations', () => {
  beforeEach(() => {
    vi.mocked(sendInvitation).mockClear();
  });

  it('caminho feliz: 200 e convida pela conta do tenant', async () => {
    const res = await postInvite(KEY_A, { provider_id: 'p1', message: 'oi' });
    expect(res.status).toBe(200);
    expect(sendInvitation).toHaveBeenCalledWith(
      expect.anything(),
      'p1',
      ACCT_A,
      'oi',
    );
  });

  it('sem provider_id responde 400 (valida antes da Unipile)', async () => {
    const res = await postInvite(KEY_A, { message: 'oi' });
    expect(res.status).toBe(400);
    expect(sendInvitation).not.toHaveBeenCalled();
  });

  it('ignora account_id do corpo: usa o do tenant, nunca o de B', async () => {
    const res = await postInvite(KEY_A, {
      provider_id: 'p1',
      account_id: ACCT_B, // tentativa de convidar pela conta de B
    });
    expect(res.status).toBe(200);
    const accountUsed = vi.mocked(sendInvitation).mock.calls.at(-1)?.[2];
    expect(accountUsed).toBe(ACCT_A);
    expect(accountUsed).not.toBe(ACCT_B);
  });
});

describe('GET /v1/chats', () => {
  beforeEach(() => {
    vi.mocked(listChats).mockClear();
  });

  it('caminho feliz: 200 e lista pela conta do tenant', async () => {
    const res = await getChats(KEY_B);
    expect(res.status).toBe(200);
    const accountUsed = vi.mocked(listChats).mock.calls.at(-1)?.[1];
    expect(accountUsed).toBe(ACCT_B);
  });

  it('repassa so paginacao, e o cursor vai para a origem com a conta do TENANT', async () => {
    // O cursor da origem carrega o account_id dentro, e a origem obedece a ele
    // antes do query string: sem reescrever, um cursor forjado leria a conta de
    // outro tenant (achado E2E de 2026-09-13).
    const forjado = 'eyJhY2NvdW50X2lkIjogWyJjb250YS1kZS1PVVRSTyJdLCAibGltaXQiOiAyLCAiY3Vyc29yIjogeyJsYXN0X2lkIjogIngifX0=';
    const res = await getChats(KEY_A, `?limit=10&cursor=${forjado}`);
    expect(res.status).toBe(200);
    const [, accountUsed, opts] = vi.mocked(listChats).mock.calls.at(-1) ?? [];
    expect(accountUsed).toBe(ACCT_A);
    expect(opts?.limit).toBe('10');
    const enviado = JSON.parse(atob(String(opts?.cursor)));
    expect(enviado.account_id).toEqual([ACCT_A]);
    expect(enviado.cursor).toEqual({ last_id: 'x' });
  });

  it('cursor ilegivel nao vira requisicao: 400 e a origem nem e chamada', async () => {
    vi.mocked(listChats).mockClear();
    const res = await getChats(KEY_A, '?cursor=nao-e-base64-de-json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_cursor' });
    expect(listChats).not.toHaveBeenCalled();
  });
});
