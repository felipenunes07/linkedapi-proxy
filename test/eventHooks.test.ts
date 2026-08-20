import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

// Hooks de evento (fase 2): /hooks/account-status, /hooks/message-received e
// /hooks/billing. Provam: gate de secret (fail-closed e timing-safe), mapeamento
// de conta/assinatura resolvido no banco (nunca confiando no payload para
// decidir tenant), transicoes de status idempotentes, pausa de billing
// intocavel pelos hooks de sessao, e repasse ao cliente sanitizado.

const STATUS_SECRET = 'secret-do-hook-de-status';
const MESSAGE_SECRET = 'secret-do-hook-de-mensagem';
const ASAAS_TOKEN = 'token-do-asaas';

interface AccountRow {
  id: string;
  tenant_id: string;
  unipile_account_id: string;
  status: string;
}
interface TokenRow {
  tenant_id: string;
  purpose: string;
  status: string;
}
const db: {
  accounts: AccountRow[];
  tenants: Record<string, { webhook_url: string | null; webhook_secret: string | null }>;
  billing: Array<{ tenant_id: string; asaas_subscription_id: string; status: string }>;
  tokens: TokenRow[];
} = { accounts: [], tenants: {}, billing: [], tokens: [] };

function matches(row: Record<string, unknown>, filters: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'select' || key === 'limit' || key === 'order') continue;
    if (value.startsWith('eq.')) {
      if (String(row[key]) !== value.slice(3)) return false;
    } else {
      return false;
    }
  }
  return true;
}

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(
    async (_env: Env, table: string, filters: Record<string, string>) => {
      if (table === 'connected_accounts') {
        return db.accounts.filter((a) => matches(a as never, filters));
      }
      if (table === 'tenants') {
        const id = filters.id?.replace(/^eq\./, '');
        const t = id ? db.tenants[id] : undefined;
        return t ? [{ id, ...t }] : [];
      }
      if (table === 'billing_subscriptions') {
        return db.billing.filter((b) => matches(b as never, filters));
      }
      return [];
    },
  ),
  supabaseInsert: vi.fn(
    async (_env: Env, table: string, row: Record<string, unknown>) => {
      if (table === 'connect_tokens') {
        db.tokens.push({
          tenant_id: row.tenant_id as string,
          purpose: row.purpose as string,
          status: row.status as string,
        });
        return [row];
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
      if (table === 'connected_accounts') {
        const rows = db.accounts.filter((a) => matches(a as never, filters));
        for (const row of rows) Object.assign(row, patch);
        return rows;
      }
      if (table === 'billing_subscriptions') {
        const rows = db.billing.filter((b) => matches(b as never, filters));
        for (const row of rows) Object.assign(row, patch);
        return rows;
      }
      return [];
    },
  ),
}));

vi.mock('../src/lib/unipile', () => ({
  createHostedAuthLink: vi.fn(
    async () =>
      new Response(JSON.stringify({ object: 'HostedAuthURL', url: 'https://wizard.example/abc' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
  getAccount: vi.fn(),
  listAccounts: vi.fn(),
}));

vi.mock('../src/lib/webhooks', () => ({
  deliverWebhook: vi.fn(async () => true),
}));

import app from '../src/index';
import { deliverWebhook } from '../src/lib/webhooks';
import { createHostedAuthLink, getAccount } from '../src/lib/unipile';
import { memoryKV } from './helpers';

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    UNIPILE_DSN: 'apiX.unipile.com:0000',
    UNIPILE_MASTER_TOKEN: 'master-token-nunca-vaza',
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-nunca-vaza',
    RATE_LIMIT: memoryKV(),
    ACCOUNT_STATUS_HOOK_SECRET: STATUS_SECRET,
    MESSAGE_HOOK_SECRET: MESSAGE_SECRET,
    ASAAS_HOOK_TOKEN: ASAAS_TOKEN,
    PUBLIC_BASE_URL: 'https://api.example.workers.dev',
    ...overrides,
  } as Env;
}

function post(path: string, body: unknown, headers: Record<string, string>, env = baseEnv()) {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env,
  );
}

beforeEach(() => {
  vi.mocked(deliverWebhook).mockClear();
  vi.mocked(createHostedAuthLink).mockClear();
  vi.mocked(getAccount).mockReset();
  // Default: a origem confirma que a sessao caiu (status != OK).
  vi.mocked(getAccount).mockResolvedValue(
    new Response(JSON.stringify({ sources: [{ status: 'CREDENTIALS' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  db.accounts = [
    { id: 'ca-1', tenant_id: 'tA', unipile_account_id: 'ua-1', status: 'active' },
    { id: 'ca-2', tenant_id: 'tB', unipile_account_id: 'ua-2', status: 'disconnected' },
    { id: 'ca-3', tenant_id: 'tC', unipile_account_id: 'ua-3', status: 'paused' },
  ];
  db.tenants = {
    tA: { webhook_url: 'https://cliente-a.example/hook', webhook_secret: 'lk_whsec_a' },
    tB: { webhook_url: null, webhook_secret: null },
    tC: { webhook_url: null, webhook_secret: null },
  };
  db.billing = [
    { tenant_id: 'tA', asaas_subscription_id: 'sub_A', status: 'active' },
    { tenant_id: 'tC', asaas_subscription_id: 'sub_C', status: 'overdue' },
  ];
  db.tokens = [];
});

describe('gate de secret (todos os hooks)', () => {
  it.each([
    ['/hooks/account-status', 'ACCOUNT_STATUS_HOOK_SECRET'],
    ['/hooks/message-received', 'MESSAGE_HOOK_SECRET'],
  ])('%s: sem secret configurado responde 500 (fail-closed)', async (path, envKey) => {
    const env = baseEnv({ [envKey]: undefined } as Partial<Env>);
    const res = await post(path, {}, { 'x-hook-secret': 'qualquer' }, env);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'hook_unavailable' });
  });

  it('secret errado responde 401 sem tocar em nada', async () => {
    const res = await post(
      '/hooks/account-status',
      { AccountStatus: { account_id: 'ua-1', message: 'CREDENTIALS' } },
      { 'x-hook-secret': 'errado' },
    );
    expect(res.status).toBe(401);
    expect(db.accounts[0]?.status).toBe('active');
  });

  it('/hooks/billing: token do Asaas errado responde 401', async () => {
    const res = await post(
      '/hooks/billing',
      { event: 'PAYMENT_OVERDUE', payment: { subscription: 'sub_A' } },
      { 'asaas-access-token': 'errado' },
    );
    expect(res.status).toBe(401);
    expect(db.accounts[0]?.status).toBe('active');
  });
});

describe('POST /hooks/account-status', () => {
  it('sessao caiu: conta ativa vira disconnected e o tenant recebe evento com link de reconexao', async () => {
    const res = await post(
      '/hooks/account-status',
      { AccountStatus: { account_id: 'ua-1', account_type: 'LINKEDIN', message: 'CREDENTIALS' } },
      { 'x-hook-secret': STATUS_SECRET },
    );
    expect(res.status).toBe(200);
    expect(db.accounts[0]?.status).toBe('disconnected');

    await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledTimes(1));
    const call = vi.mocked(deliverWebhook).mock.calls[0]!;
    expect(call[0]).toBe('https://cliente-a.example/hook');
    expect(call[2]).toBe('account.disconnected');
    expect(call[3]).toMatchObject({ reconnect_url: 'https://wizard.example/abc' });
    // O link automatizado criou um connect_token de reconexao para o tenant certo.
    expect(db.tokens).toEqual([
      { tenant_id: 'tA', purpose: 'reconnect', status: 'pending' },
    ]);
  });

  it('sessao voltou: conta disconnected vira active e notifica (sem link)', async () => {
    db.tenants.tB = { webhook_url: 'https://b.example/hook', webhook_secret: 's' };
    const res = await post(
      '/hooks/account-status',
      { AccountStatus: { account_id: 'ua-2', message: 'OK' } },
      { 'x-hook-secret': STATUS_SECRET },
    );
    expect(res.status).toBe(200);
    expect(db.accounts[1]?.status).toBe('active');
    await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledTimes(1));
    expect(vi.mocked(deliverWebhook).mock.calls[0]![2]).toBe('account.reconnected');
  });

  it('conta pausada (billing) NAO muda por status de sessao', async () => {
    const res = await post(
      '/hooks/account-status',
      { AccountStatus: { account_id: 'ua-3', message: 'OK' } },
      { 'x-hook-secret': STATUS_SECRET },
    );
    expect(res.status).toBe(200);
    expect(db.accounts[2]?.status).toBe('paused');
    expect(deliverWebhook).not.toHaveBeenCalled();
  });

  it('payload diz que caiu mas a origem diz OK: ignora (nunca confiar so no payload)', async () => {
    vi.mocked(getAccount).mockResolvedValue(
      new Response(JSON.stringify({ sources: [{ status: 'OK' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await post(
      '/hooks/account-status',
      { AccountStatus: { account_id: 'ua-1', message: 'CREDENTIALS' } },
      { 'x-hook-secret': STATUS_SECRET },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(db.accounts[0]?.status).toBe('active');
    expect(deliverWebhook).not.toHaveBeenCalled();
  });

  it('sem binding de KV: 500 (nao opera sem throttle)', async () => {
    const env = baseEnv({ RATE_LIMIT: undefined } as unknown as Partial<Env>);
    const res = await post(
      '/hooks/account-status',
      { AccountStatus: { account_id: 'ua-1', message: 'CREDENTIALS' } },
      { 'x-hook-secret': STATUS_SECRET },
      env,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'rate_limit_unavailable' });
    expect(db.accounts[0]?.status).toBe('active');
  });

  it('conta desconhecida ou status desconhecido: 200 ignored, sem efeito', async () => {
    const res1 = await post(
      '/hooks/account-status',
      { AccountStatus: { account_id: 'ua-999', message: 'CREDENTIALS' } },
      { 'x-hook-secret': STATUS_SECRET },
    );
    expect(res1.status).toBe(200);
    const res2 = await post(
      '/hooks/account-status',
      { AccountStatus: { account_id: 'ua-1', message: 'ALGO_NOVO' } },
      { 'x-hook-secret': STATUS_SECRET },
    );
    expect(res2.status).toBe(200);
    expect(db.accounts[0]?.status).toBe('active');
  });
});

describe('POST /hooks/message-received', () => {
  it('repassa ao webhook do tenant so a whitelist, sem account_id', async () => {
    const res = await post(
      '/hooks/message-received',
      {
        account_id: 'ua-1',
        chat_id: 'chat-9',
        message_id: 'msg-9',
        message: 'oi, tudo bem?',
        sender: { attendee_provider_id: 'prov-9', attendee_name: 'Fulano', attendee_id: 'interno' },
        timestamp: '2026-08-20T12:00:00.000Z',
        campo_interno: 'nao-vaza',
      },
      { 'x-hook-secret': MESSAGE_SECRET },
    );
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(deliverWebhook).toHaveBeenCalledTimes(1));
    const call = vi.mocked(deliverWebhook).mock.calls[0]!;
    expect(call[2]).toBe('message.received');
    expect(call[3]).toEqual({
      chat_id: 'chat-9',
      message_id: 'msg-9',
      text: 'oi, tudo bem?',
      attendee_provider_id: 'prov-9',
      sender_name: 'Fulano',
      timestamp: '2026-08-20T12:00:00.000Z',
    });
    const serialized = JSON.stringify(call[3]);
    expect(serialized).not.toContain('ua-1');
    expect(serialized).not.toContain('campo_interno');
  });

  it('tenant sem webhook configurado: 200 e nada e entregue', async () => {
    const res = await post(
      '/hooks/message-received',
      { account_id: 'ua-2', chat_id: 'c', message: 'x' },
      { 'x-hook-secret': MESSAGE_SECRET },
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect(deliverWebhook).not.toHaveBeenCalled();
  });
});

describe('POST /hooks/billing', () => {
  it('PAYMENT_OVERDUE pausa as contas ativas do tenant e marca a assinatura', async () => {
    const res = await post(
      '/hooks/billing',
      { event: 'PAYMENT_OVERDUE', payment: { subscription: 'sub_A' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(res.status).toBe(200);
    expect(db.accounts[0]?.status).toBe('paused');
    expect(db.billing[0]?.status).toBe('overdue');
  });

  it('PAYMENT_CONFIRMED despausa as contas do tenant e reativa a assinatura', async () => {
    const res = await post(
      '/hooks/billing',
      { event: 'PAYMENT_CONFIRMED', payment: { subscription: 'sub_C' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(res.status).toBe(200);
    expect(db.accounts[2]?.status).toBe('active');
    expect(db.billing[1]?.status).toBe('active');
  });

  it('assinatura desconhecida ou evento irrelevante: 200 ignored, sem efeito', async () => {
    const res1 = await post(
      '/hooks/billing',
      { event: 'PAYMENT_OVERDUE', payment: { subscription: 'sub_inexistente' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(res1.status).toBe(200);
    const res2 = await post(
      '/hooks/billing',
      { event: 'PAYMENT_CREATED', payment: { subscription: 'sub_A' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(res2.status).toBe(200);
    expect(db.accounts[0]?.status).toBe('active');
    expect(db.billing[0]?.status).toBe('active');
  });
});
