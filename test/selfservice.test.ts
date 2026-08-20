import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

// Self-service do tenant (fase 2): rotacao de chave e webhook. Tudo atras do
// authMiddleware; o tenant_id sai SEMPRE da chave, nunca do request.

const KEY_A = 'lk_live_key_do_tenant_A';

import { hashApiKey } from '../src/lib/hash';

// Banco em memoria mutavel: a rotacao precisa que a revogacao "pegue" nas
// resolucoes seguintes.
interface KeyRow {
  tenant_id: string;
  key_hash: string;
  status: string;
}
const db: {
  keys: KeyRow[];
  tenant: { webhook_url: string | null; webhook_secret: string | null };
} = { keys: [], tenant: { webhook_url: null, webhook_secret: null } };

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(
    async (_env: Env, table: string, filters: Record<string, string>) => {
      if (table === 'api_keys') {
        const hash = filters.key_hash?.replace(/^eq\./, '');
        return db.keys
          .filter((k) => k.key_hash === hash && `eq.${k.status}` === filters.status)
          .map((k) => ({ tenant_id: k.tenant_id }));
      }
      if (table === 'tenants') {
        if (filters.id === 'eq.tA') {
          if (filters.select === 'webhook_url') {
            return [{ webhook_url: db.tenant.webhook_url }];
          }
          return [{ id: 'tA' }];
        }
        return [];
      }
      if (table === 'connected_accounts') {
        if (filters.tenant_id === 'eq.tA') return [{ unipile_account_id: 'acct-A' }];
        return [];
      }
      return [];
    },
  ),
  supabaseInsert: vi.fn(
    async (_env: Env, table: string, row: Record<string, unknown>) => {
      if (table === 'api_keys') {
        db.keys.push({
          tenant_id: row.tenant_id as string,
          key_hash: row.key_hash as string,
          status: row.status as string,
        });
        return [{ id: `k-${db.keys.length}` }];
      }
      return [];
    },
  ),
  supabaseUpdate: vi.fn(
    async (
      _env: Env,
      table: string,
      filters: Record<string, string>,
      patch: Record<string, unknown>,
    ) => {
      if (table === 'api_keys') {
        const hash = filters.key_hash?.replace(/^eq\./, '');
        const rows = db.keys.filter(
          (k) => k.key_hash === hash && filters.tenant_id === `eq.${k.tenant_id}`,
        );
        for (const row of rows) Object.assign(row, patch);
        return rows;
      }
      if (table === 'tenants' && filters.id === 'eq.tA') {
        Object.assign(db.tenant, patch);
        return [db.tenant];
      }
      return [];
    },
  ),
}));

vi.mock('../src/lib/unipile', () => ({
  listChats: vi.fn(
    async () =>
      new Response(JSON.stringify({ items: [], cursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
}));

import app from '../src/index';
import { memoryKV } from './helpers';

const env = {
  ENVIRONMENT: 'test',
  UNIPILE_DSN: 'apiX.unipile.com:0000',
  UNIPILE_MASTER_TOKEN: 'master-token-nunca-vaza',
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-nunca-vaza',
  RATE_LIMIT: memoryKV(),
} as Env;

function req(method: string, path: string, apiKey: string, body?: unknown) {
  return app.request(
    path,
    {
      method,
      headers: { 'content-type': 'application/json', 'X-API-KEY': apiKey },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    env,
  );
}

beforeEach(async () => {
  db.keys = [
    { tenant_id: 'tA', key_hash: await hashApiKey(KEY_A), status: 'active' },
  ];
  db.tenant = { webhook_url: null, webhook_secret: null };
});

describe('POST /v1/keys/rotate', () => {
  it('emite chave nova, revoga a usada, e a nova autentica', async () => {
    const res = await req('POST', '/v1/keys/rotate', KEY_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { api_key: string } };
    const newKey = body.data.api_key;
    expect(newKey).toMatch(/^lk_live_[0-9a-f]{64}$/);

    // A chave antiga morreu.
    expect((await req('GET', '/v1/chats', KEY_A)).status).toBe(401);
    // A nova funciona.
    expect((await req('GET', '/v1/chats', newKey)).status).toBe(200);
    // So o hash foi para o banco.
    expect(db.keys.some((k) => (k.key_hash as string).startsWith('lk_live_'))).toBe(false);
  });

  it('sem chave valida, 401 (rota atras do auth)', async () => {
    const res = await req('POST', '/v1/keys/rotate', 'lk_live_invalida');
    expect(res.status).toBe(401);
  });
});

describe('/v1/webhook (configuracao do webhook do tenant)', () => {
  it('PUT registra url https e devolve secret UMA vez', async () => {
    const res = await req('PUT', '/v1/webhook', KEY_A, {
      url: 'https://cliente.example.com/hook',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { secret: string; url: string } };
    expect(body.data.secret).toMatch(/^lk_whsec_[0-9a-f]{64}$/);
    expect(db.tenant.webhook_url).toBe('https://cliente.example.com/hook');
    expect(db.tenant.webhook_secret).toBe(body.data.secret);
  });

  it.each([
    ['http', 'http://cliente.example.com/hook'],
    ['IPv4 literal', 'https://127.0.0.1/hook'],
    ['credencial embutida', 'https://user:senha@cliente.example.com/hook'],
    ['localhost', 'https://localhost/hook'],
    ['dominio .internal', 'https://api.internal/hook'],
    ['nome sem dominio', 'https://intranet/hook'],
    ['porta fora do padrao', 'https://cliente.example.com:8443/hook'],
  ])('PUT recusa destino perigoso (%s)', async (_name, url) => {
    const res = await req('PUT', '/v1/webhook', KEY_A, { url });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_url' });
    expect(db.tenant.webhook_url).toBeNull();
  });

  it('GET mostra a url mas NUNCA o secret', async () => {
    db.tenant.webhook_url = 'https://cliente.example.com/hook';
    db.tenant.webhook_secret = 'lk_whsec_super_secreto';
    const res = await req('GET', '/v1/webhook', KEY_A);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      data: { url: 'https://cliente.example.com/hook', configured: true },
    });
    expect(text).not.toContain('lk_whsec_');
  });

  it('DELETE remove a configuracao', async () => {
    db.tenant.webhook_url = 'https://cliente.example.com/hook';
    db.tenant.webhook_secret = 'lk_whsec_x';
    const res = await req('DELETE', '/v1/webhook', KEY_A);
    expect(res.status).toBe(200);
    expect(db.tenant.webhook_url).toBeNull();
    expect(db.tenant.webhook_secret).toBeNull();
  });
});
