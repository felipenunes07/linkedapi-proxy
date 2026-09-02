import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

// Endurecimento pre-clientes: sanitizacao das respostas de sucesso (white-label,
// follow-up do Marco 2), caminhos de erro upstream (502 sem vazar corpo e sem
// consumir cota), validacao de JSON, e o limiter de messages.

const KEY = 'lk_live_key_valida';
const KEY_SEM_CONTA = 'lk_live_key_tenant_sem_conta';
const ACCT = 'acct-interno-que-nao-vaza';

import { hashApiKey } from '../src/lib/tenants';

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(
    async (_env: Env, table: string, filters: Record<string, string>) => {
      const hash = await hashApiKey(KEY);
      const hashSemConta = await hashApiKey(KEY_SEM_CONTA);
      if (table === 'api_keys') {
        if (filters.key_hash === `eq.${hash}`) return [{ tenant_id: 't1' }];
        if (filters.key_hash === `eq.${hashSemConta}`) {
          return [{ tenant_id: 't3' }];
        }
        return [];
      }
      if (table === 'tenants') {
        if (filters.id === 'eq.t1') return [{ id: 't1' }];
        if (filters.id === 'eq.t3') return [{ id: 't3' }];
        return [];
      }
      if (table === 'connected_accounts') {
        if (filters.tenant_id === 'eq.t1') return [{ unipile_account_id: ACCT }];
        return []; // t3: tenant ativo, mas SEM conta conectada
      }
      return [];
    },
  ),
}));

vi.mock('../src/lib/unipile', () => ({
  sendMessage: vi.fn(),
  sendInvitation: vi.fn(),
  listChats: vi.fn(),
}));

import app from '../src/index';
import { sendMessage, sendInvitation, listChats } from '../src/lib/unipile';
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function postJson(env: Env, path: string, body: string, apiKey = KEY) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-KEY': apiKey },
      body,
    },
    env,
  );
}

// Mesma formula do counterKey em src/middleware/rateLimit.ts.
function counterKeyHoje(tenantId: string, action: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `rl:${tenantId}:${action}:${day}`;
}

beforeEach(() => {
  vi.mocked(sendMessage).mockReset();
  vi.mocked(sendInvitation).mockReset();
  vi.mocked(listChats).mockReset();
});

describe('sanitizacao das respostas de sucesso (white-label)', () => {
  it('POST /v1/messages: so message_id sai; account_id e campos internos nao', async () => {
    vi.mocked(sendMessage).mockResolvedValue(
      jsonResponse({
        object: 'MessageSent',
        message_id: 'm1',
        account_id: ACCT,
      }),
    );
    const res = await postJson(
      baseEnv(),
      '/v1/messages',
      JSON.stringify({ chat_id: 'c1', text: 'oi' }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, data: { message_id: 'm1' } });
    expect(text).not.toContain(ACCT);
    expect(text).not.toContain('MessageSent');
  });

  it('POST /v1/invitations: so invitation_id sai', async () => {
    vi.mocked(sendInvitation).mockResolvedValue(
      jsonResponse({
        object: 'UserInvitationSent',
        invitation_id: 'i1',
        account_id: ACCT,
      }),
    );
    const res = await postJson(
      baseEnv(),
      '/v1/invitations',
      JSON.stringify({ provider_id: 'p1' }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      data: { invitation_id: 'i1' },
    });
    expect(text).not.toContain(ACCT);
  });

  it('GET /v1/chats: whitelist por item, account_id do chat nunca sai, cursor passa', async () => {
    vi.mocked(listChats).mockResolvedValue(
      jsonResponse({
        object: 'ChatList',
        items: [
          {
            id: 'c1',
            account_id: ACCT,
            mailbox_id: 'interno-mb',
            name: 'Fulano',
            timestamp: '2026-08-01T12:00:00.000Z',
            unread_count: 2,
            archived: 0,
            attendee_provider_id: 'p9',
          },
        ],
        cursor: 'cur1',
      }),
    );
    const res = await app.request(
      '/v1/chats',
      { method: 'GET', headers: { 'X-API-KEY': KEY } },
      baseEnv(),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      data: {
        items: [
          {
            id: 'c1',
            name: 'Fulano',
            timestamp: '2026-08-01T12:00:00.000Z',
            unread_count: 2,
            archived: 0,
            attendee_provider_id: 'p9',
          },
        ],
        cursor: 'cur1',
      },
    });
    expect(text).not.toContain(ACCT);
    expect(text).not.toContain('interno-mb');
  });

  it('resposta upstream com forma inesperada nao quebra nem vaza: campos viram null', async () => {
    vi.mocked(sendMessage).mockResolvedValue(
      jsonResponse({ surpresa: 'campo-novo', account_id: ACCT }),
    );
    const res = await postJson(
      baseEnv(),
      '/v1/messages',
      JSON.stringify({ chat_id: 'c1', text: 'oi' }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, data: { message_id: null } });
    expect(text).not.toContain(ACCT);
    expect(text).not.toContain('surpresa');
  });
});

describe('erro upstream (502) nos 3 endpoints', () => {
  it.each([
    [
      'messages',
      () =>
        postJson(
          baseEnv(),
          '/v1/messages',
          JSON.stringify({ chat_id: 'c1', text: 'oi' }),
        ),
      sendMessage,
    ],
    [
      'invitations',
      () =>
        postJson(
          baseEnv(),
          '/v1/invitations',
          JSON.stringify({ provider_id: 'p1' }),
        ),
      sendInvitation,
    ],
    [
      'chats',
      () =>
        app.request(
          '/v1/chats',
          { method: 'GET', headers: { 'X-API-KEY': KEY } },
          baseEnv(),
        ),
      listChats,
    ],
  ] as const)(
    '%s: 502 normalizado, corpo cru do upstream nao vaza',
    async (_name, call, mock) => {
      vi.mocked(mock).mockResolvedValue(
        jsonResponse({ detail: `dsn-interno-e-${ACCT}` }, 500),
      );
      const res = await call();
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        error: 'upstream_error',
        upstream_status: 500,
      });
      expect(text).not.toContain(ACCT);
    },
  );

  it.each([[403], [404]] as const)(
    'F2.13 messages: upstream %i vira 404 not_found unico (sem oraculo, sem upstream_status)',
    async (upstream) => {
      const env = baseEnv();
      vi.mocked(sendMessage).mockResolvedValue(
        jsonResponse({ detail: `dsn-interno-e-${ACCT}` }, upstream),
      );
      const res = await postJson(
        env,
        '/v1/messages',
        JSON.stringify({ chat_id: 'c-de-outro-tenant', text: 'oi' }),
      );
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'not_found' });
      expect(text).not.toContain(ACCT);
      expect(text).not.toContain('upstream');
      // Nao consome cota.
      expect(await env.RATE_LIMIT.get(counterKeyHoje('t1', 'messages'))).toBeNull();
    },
  );

  it('F2.13 invitations: upstream 404 vira not_found (sem vazar corpo, sem cota); 403 do provider segue 502', async () => {
    const env = baseEnv();
    vi.mocked(sendInvitation).mockResolvedValueOnce(
      jsonResponse({ detail: `dsn-interno-e-${ACCT}` }, 404),
    );
    const res404 = await postJson(
      env,
      '/v1/invitations',
      JSON.stringify({ provider_id: 'perfil-inexistente' }),
    );
    expect(res404.status).toBe(404);
    const text404 = await res404.text();
    expect(JSON.parse(text404)).toEqual({ error: 'not_found' });
    expect(text404).not.toContain(ACCT);
    expect(
      await env.RATE_LIMIT.get(counterKeyHoje('t1', 'invitations')),
    ).toBeNull();

    vi.mocked(sendInvitation).mockResolvedValueOnce(jsonResponse({}, 403));
    const res403 = await postJson(
      env,
      '/v1/invitations',
      JSON.stringify({ provider_id: 'p1' }),
    );
    expect(res403.status).toBe(502);
    expect(await res403.json()).toEqual({
      error: 'upstream_error',
      upstream_status: 403,
    });
  });

  it('F2.13: o conjunto mapeado e exatamente {403,404}; upstream 401 em messages segue 502', async () => {
    vi.mocked(sendMessage).mockResolvedValue(jsonResponse({}, 401));
    const res = await postJson(
      baseEnv(),
      '/v1/messages',
      JSON.stringify({ chat_id: 'c1', text: 'oi' }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'upstream_error',
      upstream_status: 401,
    });
  });

  it('rota inexistente responde no ErrorEnvelope (nao o texto padrao do Hono)', async () => {
    const res = await app.request(
      '/v1/rota-que-nao-existe',
      { method: 'GET', headers: { 'X-API-KEY': KEY } },
      baseEnv(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('F2.13 chats: colecao sem recurso, 403 upstream segue 502 (sem mapeamento)', async () => {
    vi.mocked(listChats).mockResolvedValue(jsonResponse({}, 403));
    const res = await app.request(
      '/v1/chats',
      { method: 'GET', headers: { 'X-API-KEY': KEY } },
      baseEnv(),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: 'upstream_error',
      upstream_status: 403,
    });
  });

  it('502 nao consome cota; escrita aceita depois consome', async () => {
    const env = baseEnv();
    vi.mocked(sendMessage).mockResolvedValueOnce(jsonResponse({}, 500));
    const res = await postJson(
      env,
      '/v1/messages',
      JSON.stringify({ chat_id: 'c1', text: 'oi' }),
    );
    expect(res.status).toBe(502);
    expect(await env.RATE_LIMIT.get(counterKeyHoje('t1', 'messages'))).toBeNull();

    vi.mocked(sendMessage).mockResolvedValueOnce(
      jsonResponse({ message_id: 'm1' }),
    );
    const ok = await postJson(
      env,
      '/v1/messages',
      JSON.stringify({ chat_id: 'c1', text: 'oi' }),
    );
    expect(ok.status).toBe(200);
    expect(await env.RATE_LIMIT.get(counterKeyHoje('t1', 'messages'))).toBe('1');
  });
});

describe('validacao de corpo', () => {
  it.each([
    ['/v1/messages'],
    ['/v1/invitations'],
  ])('%s: JSON malformado responde 400 invalid_json, sem chamar a Unipile', async (path) => {
    const res = await postJson(baseEnv(), path, 'nao-e-json{');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendInvitation).not.toHaveBeenCalled();
  });

  it('/v1/invitations: message com tipo invalido responde 400 invalid_message', async () => {
    const res = await postJson(
      baseEnv(),
      '/v1/invitations',
      JSON.stringify({ provider_id: 'p1', message: 123 }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_message' });
    expect(sendInvitation).not.toHaveBeenCalled();
  });
});

describe('resolucao de tenant', () => {
  it('chave valida de tenant SEM conta conectada responde 401 (nao age por ninguem)', async () => {
    const res = await postJson(
      baseEnv(),
      '/v1/messages',
      JSON.stringify({ chat_id: 'c1', text: 'oi' }),
      KEY_SEM_CONTA,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_api_key' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('erro nao tratado (app.onError)', () => {
  it('throw no pipeline vira 500 {error: internal_error} no ErrorEnvelope, sem detalhe', async () => {
    vi.mocked(sendMessage).mockRejectedValue(
      new Error('supabase_select_failed:500'),
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await postJson(
      baseEnv(),
      '/v1/messages',
      JSON.stringify({ chat_id: 'c1', text: 'oi' }),
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal_error' });
    expect(text).not.toContain('supabase');
    // Log so name/message, nunca o objeto/stack cru.
    expect(spy).toHaveBeenCalledWith(
      'unhandled_error: Error: supabase_select_failed:500',
    );
    spy.mockRestore();
  });
});

describe('rate limit de messages (limite proprio, alem do de invitations)', () => {
  it('estourou a janela: 429 + Retry-After, sem chamar a Unipile', async () => {
    const env = baseEnv();
    await env.RATE_LIMIT.put(
      counterKeyHoje('t1', 'messages'),
      String(DAILY_LIMITS.messages),
    );
    const res = await postJson(
      env,
      '/v1/messages',
      JSON.stringify({ chat_id: 'c1', text: 'oi' }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
