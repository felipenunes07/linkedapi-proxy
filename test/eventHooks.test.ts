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
  tenants: Record<
    string,
    {
      webhook_url: string | null;
      webhook_secret: string | null;
      contact_email?: string;
      welcome_sent_at?: string | null;
    }
  >;
  billing: Array<{
    tenant_id: string;
    asaas_subscription_id: string | null;
    asaas_customer_id?: string | null;
    asaas_checkout_id?: string | null;
    payment_method?: string;
    status: string;
  }>;
  tokens: TokenRow[];
} = { accounts: [], tenants: {}, billing: [], tokens: [] };

function matches(row: Record<string, unknown>, filters: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'select' || key === 'limit' || key === 'order') continue;
    if (value === 'is.null') {
      if (row[key] !== null && row[key] !== undefined) return false;
      continue;
    }
    if (value.startsWith('eq.')) {
      if (String(row[key]) !== value.slice(3)) return false;
    } else if (value.startsWith('neq.')) {
      // PostgREST tem neq; sem isso no duble, o filtro de idempotencia do
      // cancelamento (status != canceled) nao casava com linha nenhuma.
      if (String(row[key]) === value.slice(4)) return false;
    } else if (value.startsWith('in.(')) {
      if (!value.slice(4, -1).split(',').includes(String(row[key]))) return false;
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
      if (table === 'tenants') {
        // Suporta a reivindicacao das boas-vindas (welcome_sent_at is.null).
        const id = filters.id?.replace(/^eq\./, '');
        const t = id ? db.tenants[id] : undefined;
        if (!t) return [];
        if (filters.welcome_sent_at === 'is.null' && t.welcome_sent_at) return [];
        if (filters.contact_email === 'not.is.null' && !t.contact_email) return [];
        Object.assign(t, patch);
        return [{ id, ...t }];
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

vi.mock('../src/lib/email', () => ({
  emailConfigured: vi.fn(() => true),
  sendEmail: vi.fn(async () => true),
}));

vi.mock('../src/lib/asaas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/asaas')>()),
  // Consultas ao Asaas (review F2.25): por padrao "sem resposta" (null), o
  // caminho em que o evento autenticado vale sozinho.
  getPayment: vi.fn(async () => null),
  listPayments: vi.fn(async () => null),
  enableCustomerNotifications: vi.fn(async () => true),
}));

import app from '../src/index';
import { getPayment, listPayments } from '../src/lib/asaas';
import { deliverWebhook } from '../src/lib/webhooks';
import { sendEmail } from '../src/lib/email';
import { createHostedAuthLink, getAccount } from '../src/lib/unipile';
import { memoryKV } from './helpers';

// Cobranca como o listPayments/getPayment devolve (so o que o Worker usa).
function cobrancaDe(
  id: string,
  status: string,
  subscription: string | null,
  dueDate: string | null = null,
) {
  return { id, status, subscription, customer: null, checkoutSession: null, dueDate };
}

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
  vi.mocked(sendEmail).mockClear();
  vi.mocked(createHostedAuthLink).mockClear();
  vi.mocked(getAccount).mockReset();
  vi.mocked(getPayment).mockReset().mockResolvedValue(null);
  vi.mocked(listPayments).mockReset().mockResolvedValue(null);
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
    // M5: o link vai para o usuario final do integrador, que nao tem sessao no
    // nosso painel: sem redirect para o painel.
    const corpo = vi.mocked(createHostedAuthLink).mock.calls[0]![1] as Record<string, unknown>;
    expect(corpo).not.toHaveProperty('success_redirect_url');
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

  it('#3: sessao voltou com a assinatura em atraso: vira paused, nunca active', async () => {
    db.tenants.tB = { webhook_url: 'https://b.example/hook', webhook_secret: 's' };
    db.billing.push({ tenant_id: 'tB', asaas_subscription_id: 'sub_B', status: 'overdue' });
    const res = await post(
      '/hooks/account-status',
      { AccountStatus: { account_id: 'ua-2', message: 'OK' } },
      { 'x-hook-secret': STATUS_SECRET },
    );
    expect(res.status).toBe(200);
    expect(db.accounts[1]?.status).toBe('paused');
    // A sessao voltou de fato: o integrador fica sabendo, mesmo pausada (a API
    // responde 402 account_paused ate o pagamento). Review F2.27.
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
    // Despausa nao e primeira ativacao: sem e-mail de boas-vindas.
    await new Promise((r) => setTimeout(r, 10));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('F2.20: pagamento confirmado manda UM e-mail de boas-vindas com link de uso unico', async () => {
    db.tenants.tP = { webhook_url: null, webhook_secret: null, contact_email: 'p@example.com' };
    db.billing.push({ tenant_id: 'tP', asaas_subscription_id: 'sub_P', status: 'pending' });

    const primeira = await post(
      '/hooks/billing',
      { event: 'PAYMENT_RECEIVED', payment: { subscription: 'sub_P' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(primeira.status).toBe(200);
    expect(db.billing.find((b) => b.tenant_id === 'tP')?.status).toBe('active');
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    const msg = vi.mocked(sendEmail).mock.calls[0]![1];
    expect(msg.to).toBe('p@example.com');
    // O e-mail leva LINK (uso unico, troca por sessao), nunca a sessao em si.
    expect(msg.text).toMatch(/\/painel#t=lk_plink_[0-9a-f]{64}/);
    expect(msg.text).not.toContain('lk_portal_');
    expect(db.tenants.tP.welcome_sent_at).toBeTruthy();

    // Evento em dobro do mesmo pagamento (ou retry): nao repete o e-mail.
    await post(
      '/hooks/billing',
      { event: 'PAYMENT_CONFIRMED', payment: { subscription: 'sub_P' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('Pix Automatico: 1a cobranca (assinatura nova) acha o tenant pelo CLIENTE nosso e grava a assinatura', async () => {
    db.tenants.tK = { webhook_url: null, webhook_secret: null };
    db.billing.push({
      tenant_id: 'tK',
      asaas_subscription_id: null,
      asaas_customer_id: 'cus_K',
      payment_method: 'pix_automatic',
      status: 'pending',
    });
    const res = await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_CONFIRMED',
        payment: { subscription: 'sub_nova_K', customer: 'cus_K', billingType: 'PIX' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(res.status).toBe(200);
    const linha = db.billing.find((b) => b.tenant_id === 'tK')!;
    expect(linha.status).toBe('active');
    expect(linha.asaas_subscription_id).toBe('sub_nova_K');
  });

  it('F2.25 cartao: 1a cobranca acha o tenant pela SESSAO de checkout e grava assinatura + cliente', async () => {
    db.tenants.tCard = { webhook_url: null, webhook_secret: null };
    db.billing.push({
      tenant_id: 'tCard',
      asaas_subscription_id: null,
      asaas_customer_id: null,
      asaas_checkout_id: 'chk_9',
      payment_method: 'card',
      status: 'pending',
    });
    const res = await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_CONFIRMED',
        payment: { checkoutSession: 'chk_9', subscription: 'sub_card_9', customer: 'cus_criado_pelo_asaas' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(res.status).toBe(200);
    const linha = db.billing.find((b) => b.tenant_id === 'tCard')!;
    expect(linha).toMatchObject({
      status: 'active',
      asaas_subscription_id: 'sub_card_9',
      asaas_customer_id: 'cus_criado_pelo_asaas',
    });
  });

  it('F2.25 cartao: CHECKOUT_PAID ativa pela sessao e grava a assinatura da cobranca dela', async () => {
    db.tenants.tCard2 = { webhook_url: null, webhook_secret: null };
    db.billing.push({
      tenant_id: 'tCard2',
      asaas_subscription_id: null,
      asaas_customer_id: null,
      asaas_checkout_id: 'chk_10',
      payment_method: 'card',
      status: 'pending',
    });
    vi.mocked(listPayments).mockImplementation(async (_env, filtro) =>
      filtro.checkoutSession === 'chk_10'
        ? [
            {
              id: 'pay_10',
              status: 'CONFIRMED',
              subscription: 'sub_card_10',
              customer: 'cus_10',
              checkoutSession: 'chk_10',
              dueDate: null,
            },
          ]
        : [],
    );
    await post(
      '/hooks/billing',
      { event: 'CHECKOUT_PAID', checkout: { id: 'chk_10', customer: 'cus_10', status: 'PAID' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    // Sem a assinatura gravada, a cobranca do mes 2 nao acharia o tenant.
    expect(db.billing.find((b) => b.tenant_id === 'tCard2')).toMatchObject({
      status: 'active',
      asaas_customer_id: 'cus_10',
      asaas_subscription_id: 'sub_card_10',
    });
  });

  it('#2 cartao: cobranca sem checkoutSession no payload acha a sessao pelo Asaas', async () => {
    db.tenants.tCard3 = { webhook_url: null, webhook_secret: null };
    db.billing.push({
      tenant_id: 'tCard3',
      asaas_subscription_id: null,
      asaas_customer_id: null,
      asaas_checkout_id: 'chk_11',
      payment_method: 'card',
      status: 'pending',
    });
    vi.mocked(getPayment).mockResolvedValue({
      id: 'pay_11',
      status: 'CONFIRMED',
      subscription: 'sub_card_11',
      customer: 'cus_11',
      checkoutSession: 'chk_11',
      dueDate: null,
    });
    const res = await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_11', subscription: 'sub_card_11', customer: 'cus_11', billingType: 'CREDIT_CARD' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(await res.json()).toEqual({ ok: true });
    expect(getPayment).toHaveBeenCalledWith(expect.anything(), 'pay_11');
    expect(db.billing.find((b) => b.tenant_id === 'tCard3')).toMatchObject({
      status: 'active',
      asaas_subscription_id: 'sub_card_11',
      asaas_customer_id: 'cus_11',
    });
  });

  it('#1 cartao: a liquidacao (PAYMENT_RECEIVED) nunca desfaz a pausa de um atraso posterior', async () => {
    await post(
      '/hooks/billing',
      { event: 'PAYMENT_OVERDUE', payment: { id: 'pay_mes2', subscription: 'sub_A', billingType: 'CREDIT_CARD' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(db.accounts[0]?.status).toBe('paused');
    const res = await post(
      '/hooks/billing',
      { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_mes1', subscription: 'sub_A', billingType: 'CREDIT_CARD' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(db.accounts[0]?.status).toBe('paused');
    expect(db.billing[0]?.status).toBe('overdue');
  });

  it('#1: confirmacao atrasada do mes 1 com o mes 2 VENCIDO: continua pausado', async () => {
    vi.mocked(listPayments).mockImplementation(async (_env, filtro) =>
      filtro.subscription === 'sub_C'
        ? [
            cobrancaDe('pay_mes2', 'OVERDUE', 'sub_C', '2026-10-10'),
            cobrancaDe('pay_mes1', 'CONFIRMED', 'sub_C', '2026-09-10'),
          ]
        : [],
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_mes1', subscription: 'sub_C', dueDate: '2026-09-10' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(db.accounts[2]?.status).toBe('paused');
    expect(db.billing[1]?.status).toBe('overdue');
    expect(errSpy.mock.calls.map((c) => String(c[0]))).toContain('billing_still_overdue: tC');
    errSpy.mockRestore();
  });

  it('#1: atraso de uma cobranca que no Asaas ja foi paga (evento velho) nao pausa', async () => {
    vi.mocked(getPayment).mockResolvedValue(cobrancaDe('pay_A1', 'RECEIVED', 'sub_A'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(
      '/hooks/billing',
      { event: 'PAYMENT_OVERDUE', payment: { id: 'pay_A1', subscription: 'sub_A' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(getPayment).toHaveBeenCalledWith(expect.anything(), 'pay_A1');
    expect(db.accounts[0]?.status).toBe('active');
    expect(db.billing[0]?.status).toBe('active');
    errSpy.mockRestore();
  });

  it('contestacao do cartao (chargeback) pausa como atraso', async () => {
    await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_CHARGEBACK_REQUESTED',
        payment: { id: 'pay_cb', subscription: 'sub_A', billingType: 'CREDIT_CARD' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(db.accounts[0]?.status).toBe('paused');
    expect(db.billing[0]?.status).toBe('overdue');
  });

  it('B1: cliente de um tenant de CARTAO nunca serve de ancora (assinatura alheia nao pausa ninguem)', async () => {
    db.billing.push({
      tenant_id: 'tB1',
      asaas_subscription_id: 'sub_legitima',
      asaas_customer_id: 'cus_vitima',
      asaas_checkout_id: 'chk_vitima',
      payment_method: 'card',
      status: 'active',
    });
    // Atacante paga checkout proprio e o Asaas reaproveita o cliente da vitima
    // por CPF: chega assinatura desconhecida + cliente da vitima, sem sessao nossa.
    const res = await post(
      '/hooks/billing',
      { event: 'PAYMENT_CONFIRMED', payment: { subscription: 'sub_atacante', customer: 'cus_vitima' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    await post(
      '/hooks/billing',
      { event: 'PAYMENT_OVERDUE', payment: { subscription: 'sub_atacante', customer: 'cus_vitima' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    const vitima = db.billing.find((b) => b.tenant_id === 'tB1')!;
    expect(vitima).toMatchObject({ status: 'active', asaas_subscription_id: 'sub_legitima' });
  });

  it('B1: nunca sobrescreve a assinatura ja vinculada (conflito e ignorado)', async () => {
    db.billing.push({
      tenant_id: 'tPx',
      asaas_subscription_id: 'sub_original',
      asaas_customer_id: 'cus_px',
      payment_method: 'pix_automatic',
      status: 'active',
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_OVERDUE',
        payment: { subscription: 'sub_outra', customer: 'cus_px', billingType: 'PIX' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(db.billing.find((b) => b.tenant_id === 'tPx')).toMatchObject({
      asaas_subscription_id: 'sub_original',
      status: 'active',
    });
    expect(errSpy.mock.calls.map((c) => String(c[0]))).toContain('billing_subscription_conflict: tPx');
    errSpy.mockRestore();
  });

  it('assinatura E cliente desconhecidos: 200 ignored, sem efeito', async () => {
    const res = await post(
      '/hooks/billing',
      { event: 'PAYMENT_CONFIRMED', payment: { subscription: 'sub_x', customer: 'cus_de_ninguem' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(await res.json()).toEqual({ ok: true, ignored: true });
  });

  it('M1: envio que falha devolve a vez; o proximo pagamento confirmado tenta de novo', async () => {
    db.tenants.tQ = { webhook_url: null, webhook_secret: null, contact_email: 'q@example.com' };
    db.billing.push({ tenant_id: 'tQ', asaas_subscription_id: 'sub_Q', status: 'pending' });
    vi.mocked(sendEmail).mockResolvedValueOnce(false);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await post(
      '/hooks/billing',
      { event: 'PAYMENT_RECEIVED', payment: { subscription: 'sub_Q' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(db.tenants.tQ?.welcome_sent_at).toBeNull());

    await post(
      '/hooks/billing',
      { event: 'PAYMENT_CONFIRMED', payment: { subscription: 'sub_Q' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(db.tenants.tQ?.welcome_sent_at).toBeTruthy());
    expect(errSpy.mock.calls.map((c) => String(c[0]))).toContain('portal_welcome_email_failed');
    errSpy.mockRestore();
  });

  it('F2.27: mes 2 vencido e mes 3 pago: reativa (vencida ANTERIOR nao segura quem pagou)', async () => {
    vi.mocked(listPayments).mockImplementation(async (_env, filtro) =>
      filtro.subscription === 'sub_C'
        ? [
            cobrancaDe('pay_mes2', 'OVERDUE', 'sub_C', '2026-10-10'),
            cobrancaDe('pay_mes3', 'CONFIRMED', 'sub_C', '2026-11-10'),
          ]
        : [],
    );
    const res = await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_mes3', subscription: 'sub_C', dueDate: '2026-11-10' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(await res.json()).toEqual({ ok: true });
    expect(db.accounts[2]?.status).toBe('active');
    expect(db.billing[1]?.status).toBe('active');
  });

  it('F2.27: contestacao (chargeback) aberta na assinatura: pagamento novo nao despausa', async () => {
    vi.mocked(listPayments).mockImplementation(async (_env, filtro) =>
      filtro.subscription === 'sub_C'
        ? [cobrancaDe('pay_mes1', 'CHARGEBACK_DISPUTE', 'sub_C', '2026-09-10')]
        : [],
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_mes2', subscription: 'sub_C', dueDate: '2026-10-10', billingType: 'CREDIT_CARD' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(db.accounts[2]?.status).toBe('paused');
    expect(errSpy.mock.calls.map((c) => String(c[0]))).toContain('billing_chargeback_open: tC');
    errSpy.mockRestore();
  });

  it.each(['DUNNING_REQUESTED', 'AWAITING_RISK_ANALYSIS'])(
    'F2.27: atraso de cobranca em %s (sem dinheiro) pausa',
    async (status) => {
      vi.mocked(getPayment).mockResolvedValue(cobrancaDe('pay_A2', status, 'sub_A'));
      await post(
        '/hooks/billing',
        { event: 'PAYMENT_OVERDUE', payment: { id: 'pay_A2', subscription: 'sub_A' } },
        { 'asaas-access-token': ASAAS_TOKEN },
      );
      expect(db.accounts[0]?.status).toBe('paused');
      expect(db.billing[0]?.status).toBe('overdue');
    },
  );

  it('F2.27: CHECKOUT_PAID de sessao alheia com o cliente de um tenant Pix pendente: ignorado', async () => {
    db.billing.push({
      tenant_id: 'tPend',
      asaas_subscription_id: null,
      asaas_customer_id: 'cus_T',
      payment_method: 'pix_automatic',
      status: 'pending',
    });
    vi.mocked(listPayments).mockResolvedValue([
      { ...cobrancaDe('pay_x', 'CONFIRMED', 'sub_alheia'), customer: 'cus_T', checkoutSession: 'chk_alheio' },
    ]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(
      '/hooks/billing',
      { event: 'CHECKOUT_PAID', checkout: { id: 'chk_alheio', customer: 'cus_T', status: 'PAID' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(db.billing.find((b) => b.tenant_id === 'tPend')).toMatchObject({
      status: 'pending',
      asaas_subscription_id: null,
    });
    errSpy.mockRestore();
  });

  it('F2.27: teto do /billing estourado responde 200 (nunca trava a fila sequencial do Asaas)', async () => {
    const env = baseEnv();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let ultima: Response | undefined;
    for (let i = 0; i < 51; i++) {
      ultima = await post(
        '/hooks/billing',
        { event: 'PAYMENT_CONFIRMED', payment: { id: `pay_${i}`, subscription: 'sub_A' } },
        { 'asaas-access-token': ASAAS_TOKEN },
        env,
      );
    }
    expect(ultima!.status).toBe(200);
    expect(await ultima!.json()).toEqual({ ok: true, ignored: true });
    expect(errSpy.mock.calls.map((c) => String(c[0]))).toContain('billing_throttled: tA');
    errSpy.mockRestore();
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

// F2.29: com dois assentos, o MESMO cliente do Asaas pode ancorar duas
// assinaturas nossas. Ativar o assento errado deixaria quem pagou sem conta e
// quem nao pagou com conta, entao o cliente so decide quando nao ha duvida.
describe('POST /hooks/billing, dois assentos do mesmo cliente (F2.29)', () => {
  beforeEach(() => {
    db.tenants.tS1 = { webhook_url: null, webhook_secret: null };
    db.tenants.tS2 = { webhook_url: null, webhook_secret: null };
    db.accounts.push(
      { id: 'ca-s1', tenant_id: 'tS1', unipile_account_id: 'ua-s1', status: 'active' },
      { id: 'ca-s2', tenant_id: 'tS2', unipile_account_id: 'ua-s2', status: 'active' },
    );
  });

  it('assento 1 ja pago, assento 2 esperando: a cobranca PIX ativa o que espera', async () => {
    db.billing.push(
      {
        tenant_id: 'tS1',
        asaas_subscription_id: 'sub_S1',
        asaas_customer_id: 'cus_mesmo',
        payment_method: 'pix_automatic',
        status: 'active',
      },
      {
        tenant_id: 'tS2',
        asaas_subscription_id: null,
        asaas_customer_id: 'cus_mesmo',
        payment_method: 'pix_automatic',
        status: 'pending',
      },
    );

    const res = await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_2', billingType: 'PIX', customer: 'cus_mesmo' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(res.status).toBe(200);
    expect(db.billing.find((b) => b.tenant_id === 'tS2')?.status).toBe('active');
    expect(db.billing.find((b) => b.tenant_id === 'tS1')?.status).toBe('active');
  });

  it('dois assentos esperando o primeiro pagamento: nao chuta, ignora e sinaliza', async () => {
    db.billing.push(
      {
        tenant_id: 'tS1',
        asaas_subscription_id: null,
        asaas_customer_id: 'cus_mesmo',
        payment_method: 'pix_automatic',
        status: 'pending',
      },
      {
        tenant_id: 'tS2',
        asaas_subscription_id: null,
        asaas_customer_id: 'cus_mesmo',
        payment_method: 'pix_automatic',
        status: 'pending',
      },
    );

    const res = await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_3', billingType: 'PIX', customer: 'cus_mesmo' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(db.billing.filter((b) => b.status === 'pending')).toHaveLength(2);
  });

  it('assinatura conhecida continua decidindo antes do cliente (renovacao do assento certo)', async () => {
    db.billing.push(
      {
        tenant_id: 'tS1',
        asaas_subscription_id: 'sub_S1',
        asaas_customer_id: 'cus_mesmo',
        payment_method: 'pix_automatic',
        status: 'overdue',
      },
      {
        tenant_id: 'tS2',
        asaas_subscription_id: 'sub_S2',
        asaas_customer_id: 'cus_mesmo',
        payment_method: 'pix_automatic',
        status: 'active',
      },
    );

    const res = await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_4', billingType: 'PIX', customer: 'cus_mesmo', subscription: 'sub_S1' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(res.status).toBe(200);
    expect(db.billing.find((b) => b.tenant_id === 'tS1')?.status).toBe('active');
  });
});

// F2.31: o caso que mais dói do review. Quem apenas repetiu o checkout (o
// fluxo permite; a tentativa anterior vira `canceled` com o mesmo cliente do
// Asaas e sem assinatura) nao pode ter o pagamento REAL descartado por
// "ambiguidade". Dinheiro entrando e assento nunca ativado, sem reprocesso.
describe('POST /hooks/billing, linha cancelada do mesmo cliente (F2.31)', () => {
  it('checkout refeito: a linha canceled nao torna o pagamento ambiguo', async () => {
    db.tenants.tR1 = { webhook_url: null, webhook_secret: null };
    db.tenants.tR2 = { webhook_url: null, webhook_secret: null };
    db.accounts.push({ id: 'ca-r2', tenant_id: 'tR2', unipile_account_id: 'ua-r2', status: 'active' });
    db.billing.push(
      // Tentativa abandonada: mesmo cliente no Asaas, sem assinatura.
      {
        tenant_id: 'tR1',
        asaas_subscription_id: null,
        asaas_customer_id: 'cus_repetido',
        payment_method: 'pix_automatic',
        status: 'canceled',
      },
      // A venda que vale.
      {
        tenant_id: 'tR2',
        asaas_subscription_id: null,
        asaas_customer_id: 'cus_repetido',
        payment_method: 'pix_automatic',
        status: 'pending',
      },
    );

    const res = await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_r', billingType: 'PIX', customer: 'cus_repetido' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(res.status).toBe(200);
    expect(db.billing.find((b) => b.tenant_id === 'tR2')?.status).toBe('active');
    expect(db.billing.find((b) => b.tenant_id === 'tR1')?.status).toBe('canceled');
  });

  it('ambiguidade de verdade: o sinal leva os tenants, para dar para reconciliar', async () => {
    db.tenants.tR3 = { webhook_url: null, webhook_secret: null };
    db.tenants.tR4 = { webhook_url: null, webhook_secret: null };
    db.billing.push(
      {
        tenant_id: 'tR3',
        asaas_subscription_id: null,
        asaas_customer_id: 'cus_duplo',
        payment_method: 'pix_automatic',
        status: 'pending',
      },
      {
        tenant_id: 'tR4',
        asaas_subscription_id: null,
        asaas_customer_id: 'cus_duplo',
        payment_method: 'pix_automatic',
        status: 'pending',
      },
    );
    const erros: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      erros.push(String(args[0]));
    });

    const res = await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_d', billingType: 'PIX', customer: 'cus_duplo' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(db.billing.filter((b) => b.asaas_customer_id === 'cus_duplo' && b.status === 'pending')).toHaveLength(2);
    const linha = erros.find((l) => l.startsWith('billing_ambiguous_customer'));
    expect(linha).toContain('tR3');
    expect(linha).toContain('tR4');
    spy.mockRestore();
  });
});

// F2.37: assinatura cancelada por fora (painel do gateway ou app do banco).
// Antes disso, nada era escutado: sem cobranca nova nao vem PAYMENT_OVERDUE, e
// a conta seguia servindo para sempre. Cancelar NAO corta na hora, o periodo
// pago vale ate o fim.
describe('POST /hooks/billing, assinatura cancelada (F2.37)', () => {
  beforeEach(() => {
    db.tenants.tCan = { webhook_url: null, webhook_secret: null };
    db.accounts.push({
      id: 'ca-can',
      tenant_id: 'tCan',
      unipile_account_id: 'ua-can',
      status: 'active',
    });
    db.billing.push({
      tenant_id: 'tCan',
      asaas_subscription_id: 'sub_can',
      asaas_customer_id: 'cus_can',
      payment_method: 'pix_automatic',
      status: 'active',
    });
  });

  it('SUBSCRIPTION_DELETED marca cancelado e NAO pausa a conta agora', async () => {
    const res = await post(
      '/hooks/billing',
      { event: 'SUBSCRIPTION_DELETED', subscription: { id: 'sub_can' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(res.status).toBe(200);
    expect(db.billing.find((b) => b.tenant_id === 'tCan')?.status).toBe('canceled');
    expect(db.accounts.find((a) => a.tenant_id === 'tCan')?.status).toBe('active');
  });

  it('SUBSCRIPTION_INACTIVATED vale igual, e reentrega nao muda nada', async () => {
    await post(
      '/hooks/billing',
      { event: 'SUBSCRIPTION_INACTIVATED', subscription: { id: 'sub_can' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    const res = await post(
      '/hooks/billing',
      { event: 'SUBSCRIPTION_INACTIVATED', subscription: { id: 'sub_can' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(res.status).toBe(200);
    expect(db.billing.find((b) => b.tenant_id === 'tCan')?.status).toBe('canceled');
  });

  it('pagamento confirmado grava ate quando a conta serve (periodo pago)', async () => {
    await post(
      '/hooks/billing',
      {
        event: 'PAYMENT_CONFIRMED',
        payment: { id: 'pay_can', subscription: 'sub_can', dueDate: '2026-09-10' },
      },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    const linha = db.billing.find((b) => b.tenant_id === 'tCan') as Record<string, unknown>;
    expect(linha.status).toBe('active');
    const ate = Date.parse(String(linha.access_until));
    // Vencimento pago + um ciclo com folga: dentro de outubro.
    expect(ate).toBeGreaterThan(Date.parse('2026-10-10'));
    expect(ate).toBeLessThan(Date.parse('2026-10-16'));
  });

  it('evento de assinatura desconhecida nao cria nem toca nada', async () => {
    const res = await post(
      '/hooks/billing',
      { event: 'SUBSCRIPTION_DELETED', subscription: { id: 'sub_que_nao_existe' } },
      { 'asaas-access-token': ASAAS_TOKEN },
    );
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(db.billing.find((b) => b.tenant_id === 'tCan')?.status).toBe('active');
  });
});
