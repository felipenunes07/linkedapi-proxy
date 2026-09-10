import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../src/types';
import { memoryKV } from './helpers';
import { hashApiKey } from '../src/lib/hash';

// Painel do cliente (F2.20 + endurecimento F2.21): o cliente conecta o
// LinkedIn e gera a chave sem operador. Provam: a SESSAO do painel decide o
// tenant (nunca o request), so hash no banco, link do e-mail e de uso unico e
// nao serve como sessao, a chave so nasce com pagamento ativo + LinkedIn
// conectado, "sair de todos" derruba tudo, throttle em camadas e o "entrar"
// nao vira oraculo de e-mail.

type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
let seq = 0;
let emailLigado = true;

function matches(row: Row, filters: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'select' || key === 'limit' || key === 'order') continue;
    const cru = row[key];
    if (value === 'is.null') {
      if (cru !== null && cru !== undefined) return false;
      continue;
    }
    if (value === 'not.is.null') {
      if (cru === null || cru === undefined) return false;
      continue;
    }
    const atual = String(cru);
    if (value.startsWith('eq.')) {
      if (atual !== value.slice(3)) return false;
    } else if (value.startsWith('neq.')) {
      if (atual === value.slice(4)) return false;
    } else if (value.startsWith('gt.')) {
      if (!(atual > value.slice(3))) return false;
    } else if (value.startsWith('lt.')) {
      if (!(atual < value.slice(3))) return false;
    } else if (value.startsWith('in.(')) {
      if (!value.slice(4, -1).split(',').includes(atual)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function selecionar(table: string, filters: Record<string, string>): Row[] {
  let rows = (db[table] ?? []).filter((r) => matches(r, filters));
  if (filters.order === 'created_at.desc') {
    rows = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }
  if (filters.limit) rows = rows.slice(0, Number(filters.limit));
  return rows.map((r) => ({ ...r }));
}

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(async (_env: Env, table: string, filters: Record<string, string>) =>
    selecionar(table, filters),
  ),
  supabaseInsert: vi.fn(async (_env: Env, table: string, row: Row) => {
    seq += 1;
    const completo = {
      id: `id-${seq}`,
      created_at: new Date(Date.UTC(2026, 8, 10, 12, 0, seq)).toISOString(),
      ...row,
    };
    (db[table] ??= []).push(completo);
    return [{ ...completo }];
  }),
  supabaseUpdate: vi.fn(
    async (_env: Env, table: string, filters: Record<string, string>, patch: Row) => {
      const rows = (db[table] ?? []).filter((r) => matches(r, filters));
      for (const r of rows) Object.assign(r, patch);
      return rows.map((r) => ({ ...r }));
    },
  ),
  supabaseRpcSelect: vi.fn(async (_env: Env, fn: string, args: Row) => {
    if (fn !== 'find_tenants_by_contact_email') return [];
    const alvo = String(args.p_email).trim().toLowerCase();
    return (db.tenants ?? [])
      .filter((t) => t.contact_email === alvo && t.status === 'active')
      .map((t) => ({ id: t.id }));
  }),
  supabaseDelete: vi.fn(async () => undefined),
  supabaseRpc: vi.fn(async () => undefined),
}));

vi.mock('../src/lib/unipile', () => ({
  createHostedAuthLink: vi.fn(
    async () =>
      new Response(JSON.stringify({ object: 'HostedAuthURL', url: 'https://wizard.example/xyz' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
  getAccount: vi.fn(),
  listAccounts: vi.fn(),
}));

vi.mock('../src/lib/email', () => ({
  emailConfigured: vi.fn(() => emailLigado),
  sendEmail: vi.fn(async () => true),
}));

vi.mock('../src/lib/asaas', () => ({
  updateCustomerEmail: vi.fn(async () => true),
}));

import app from '../src/index';
import { createHostedAuthLink } from '../src/lib/unipile';
import { sendEmail } from '../src/lib/email';
import { updateCustomerEmail } from '../src/lib/asaas';

const TOKEN_A = `lk_portal_${'a'.repeat(64)}`;
const TOKEN_B = `lk_portal_${'b'.repeat(64)}`;
const FUTURO = '2099-01-01T00:00:00.000Z';
const PASSADO = '2000-01-01T00:00:00.000Z';

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    UNIPILE_DSN: 'apiX.unipile.com:0000',
    UNIPILE_MASTER_TOKEN: 'master-token-nunca-vaza',
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-nunca-vaza',
    RATE_LIMIT: memoryKV(),
    PUBLIC_BASE_URL: 'https://api.example.workers.dev',
    PORTAL_URL: 'https://site.example/painel.html',
    ...overrides,
  } as Env;
}

function req(
  path: string,
  opts: {
    method?: string;
    token?: string;
    body?: unknown;
    origin?: string;
    ip?: string;
    contentType?: string;
  } = {},
  env: Env = baseEnv(),
) {
  const headers: Record<string, string> = {};
  if (opts.token) headers['X-PORTAL-TOKEN'] = opts.token;
  if (opts.origin) headers.Origin = opts.origin;
  if (opts.ip) headers['CF-Connecting-IP'] = opts.ip;
  if (opts.body !== undefined) headers['content-type'] = opts.contentType ?? 'application/json';
  return app.request(
    path,
    {
      method: opts.method ?? 'GET',
      headers,
      body:
        opts.body === undefined
          ? undefined
          : typeof opts.body === 'string'
            ? opts.body
            : JSON.stringify(opts.body),
    },
    env,
  );
}

async function linkDoTenant(tenantId: string, extra: Row = {}): Promise<string> {
  seq += 1;
  const token = `lk_plink_${String(seq).padStart(64, '0')}`;
  db.portal_tokens!.push({
    id: `pl-${seq}`,
    tenant_id: tenantId,
    token_hash: await hashApiKey(token),
    kind: 'link',
    status: 'active',
    expires_at: FUTURO,
    ...extra,
  });
  return token;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  for (const k of Object.keys(db)) delete db[k];
  seq = 0;
  emailLigado = true;
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  // Tenant A: pagou, ainda sem LinkedIn e sem chave (o caso do onboarding).
  // Tenant B: pagou, LinkedIn conectado, com uma chave ativa.
  db.tenants = [
    { id: 'tA', name: 'Cliente A', status: 'active', contact_email: 'a@example.com', daily_message_limit: null, daily_invitation_limit: null, created_at: '2026-09-01T00:00:00.000Z' },
    { id: 'tB', name: 'Cliente B', status: 'active', contact_email: 'b@example.com', daily_message_limit: 100, daily_invitation_limit: null, created_at: '2026-09-01T00:00:00.000Z' },
  ];
  db.portal_tokens = [
    { id: 'pt-a', tenant_id: 'tA', token_hash: await hashApiKey(TOKEN_A), kind: 'session', status: 'active', expires_at: FUTURO },
    { id: 'pt-b', tenant_id: 'tB', token_hash: await hashApiKey(TOKEN_B), kind: 'session', status: 'active', expires_at: FUTURO },
  ];
  db.billing_subscriptions = [
    { tenant_id: 'tA', status: 'active', asaas_customer_id: 'cus_A' },
    { tenant_id: 'tB', status: 'active', asaas_customer_id: 'cus_B' },
  ];
  db.connected_accounts = [
    { id: 'ca-b', tenant_id: 'tB', unipile_account_id: 'ua-b', provider: 'linkedin', status: 'active', created_at: '2026-09-02T00:00:00.000Z' },
  ];
  db.api_keys = [
    { id: 'k-b', tenant_id: 'tB', key_hash: 'hash-antigo-b', status: 'active', created_at: '2026-09-01T00:00:00.000Z' },
  ];
  db.connect_tokens = [];
  db.usage_daily = [];
});

afterEach(() => {
  // Log nunca carrega credencial do painel, e-mail do cliente nem id da origem.
  for (const call of errorSpy.mock.calls) {
    const line = String(call[0]);
    expect(line).not.toContain('lk_portal_');
    expect(line).not.toContain('lk_plink_');
    expect(line).not.toContain('@example.com');
    expect(line).not.toContain('ua-');
  }
  errorSpy.mockRestore();
});

describe('portal: autenticacao por sessao', () => {
  it('sem KV responde 500 (fail-closed)', async () => {
    const env = baseEnv({ RATE_LIMIT: undefined as unknown as KVNamespace });
    const res = await req('/portal/status', { token: TOKEN_A }, env);
    expect(res.status).toBe(500);
  });

  it('sem token: 401 missing_portal_token', async () => {
    const res = await req('/portal/status');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'missing_portal_token' });
  });

  it('inexistente, expirado, revogado, de tenant suspenso ou LINK no lugar de sessao: 401 igual', async () => {
    const expirado = `lk_portal_${'c'.repeat(64)}`;
    const revogado = `lk_portal_${'d'.repeat(64)}`;
    const suspenso = `lk_portal_${'e'.repeat(64)}`;
    db.tenants!.push({ id: 'tS', name: 'Suspenso', status: 'suspended' });
    db.portal_tokens!.push(
      { id: 'x1', tenant_id: 'tA', token_hash: await hashApiKey(expirado), kind: 'session', status: 'active', expires_at: PASSADO },
      { id: 'x2', tenant_id: 'tA', token_hash: await hashApiKey(revogado), kind: 'session', status: 'revoked', expires_at: FUTURO },
      { id: 'x3', tenant_id: 'tS', token_hash: await hashApiKey(suspenso), kind: 'session', status: 'active', expires_at: FUTURO },
    );
    const link = await linkDoTenant('tA');
    for (const token of [`lk_portal_${'f'.repeat(64)}`, expirado, revogado, suspenso, link]) {
      const res = await req('/portal/status', { token });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid_portal_token' });
    }
  });

  it('muitos tokens invalidos do mesmo IP: 429 antes do banco, ate para sessao valida', async () => {
    const env = baseEnv();
    for (let i = 0; i < 30; i++) {
      await req('/portal/status', { token: `lk_portal_errado${i}`, ip: '7.7.7.7' }, env);
    }
    const res = await req('/portal/status', { token: TOKEN_A, ip: '7.7.7.7' }, env);
    expect(res.status).toBe(429);
    const outro = await req('/portal/status', { token: TOKEN_A, ip: '8.8.8.8' }, env);
    expect(outro.status).toBe(200);
  });

  it('sessao revogada ou vencida (cliente com dado velho) NAO pune o IP', async () => {
    const velha = `lk_portal_${'7'.repeat(64)}`;
    db.portal_tokens!.push({
      id: 'x-velha',
      tenant_id: 'tA',
      token_hash: await hashApiKey(velha),
      kind: 'session',
      status: 'revoked',
      expires_at: FUTURO,
    });
    const env = baseEnv();
    for (let i = 0; i < 40; i++) {
      expect((await req('/portal/status', { token: velha, ip: '7.7.7.8' }, env)).status).toBe(401);
    }
    expect((await req('/portal/status', { token: TOKEN_A, ip: '7.7.7.8' }, env)).status).toBe(200);
  });

  it('CORS: origem fora da allowlist e recusada; preflight libera o header e o PUT', async () => {
    const fora = await req('/portal/status', { token: TOKEN_A, origin: 'https://site-malicioso.com' });
    expect(fora.status).toBe(403);

    const preflight = await app.request(
      '/portal/email',
      { method: 'OPTIONS', headers: { Origin: 'https://linkedapi-site.pages.dev' } },
      baseEnv(),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('x-portal-token');
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
  });
});

describe('POST /portal/session (link do e-mail -> sessao)', () => {
  it('troca link valido por sessao nova; o link morre no primeiro uso', async () => {
    const env = baseEnv();
    const link = await linkDoTenant('tA');
    const res = await req('/portal/session', { method: 'POST', body: { token: link } }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as { data: { token: string } };
    expect(body.data.token).toMatch(/^lk_portal_[0-9a-f]{64}$/);

    const hashNova = await hashApiKey(body.data.token);
    expect(db.portal_tokens!.find((t) => t.token_hash === hashNova)).toMatchObject({
      tenant_id: 'tA',
      kind: 'session',
      status: 'active',
    });
    const hashLink = await hashApiKey(link);
    expect(db.portal_tokens!.find((t) => t.token_hash === hashLink)!.status).toBe('used');

    expect((await req('/portal/status', { token: body.data.token }, env)).status).toBe(200);
    const denovo = await req('/portal/session', { method: 'POST', body: { token: link } }, env);
    expect(denovo.status).toBe(401);
    expect(await denovo.json()).toEqual({ error: 'invalid_link' });
  });

  it('link expirado, revogado ou uma SESSAO no lugar do link: 401', async () => {
    const expirado = await linkDoTenant('tA', { expires_at: PASSADO });
    const revogado = await linkDoTenant('tA', { status: 'revoked' });
    for (const token of [expirado, revogado, TOKEN_A, 'lixo']) {
      const res = await req('/portal/session', { method: 'POST', body: { token } });
      expect(res.status).toBe(401);
    }
  });

  it('content-type nao-json: 415', async () => {
    const res = await req('/portal/session', {
      method: 'POST',
      body: 'token=x',
      contentType: 'text/plain',
    });
    expect(res.status).toBe(415);
  });
});

describe('GET /portal/status', () => {
  it('mostra o estado da conta sem ids internos e sem cache', async () => {
    db.usage_daily!.push({
      tenant_id: 'tB',
      action: 'messages',
      day: new Date().toISOString().slice(0, 10),
      count: 7,
    });
    const res = await req('/portal/status', { token: TOKEN_B });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      data: {
        name: 'Cliente B',
        email: 'b@example.com',
        subscription: 'active',
        linkedin: 'active',
        has_key: true,
        limits: { messages: 100, invitations: 30 },
        usage_today: { messages: 7, invitations: 0 },
        docs_url: 'http://localhost/docs',
        email_login: true,
      },
    });
    expect(text).not.toContain('ua-b');
    expect(text).not.toContain('tB');
    expect(text).not.toContain('hash-antigo-b');
  });

  it('cliente recem-chegado: assinatura pendente, sem LinkedIn, sem chave', async () => {
    db.billing_subscriptions![0]!.status = 'pending';
    const res = await req('/portal/status', { token: TOKEN_A });
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ subscription: 'pending', linkedin: 'none', has_key: false });
  });
});

describe('POST /portal/connect', () => {
  it('pagamento ainda pendente: 402, nenhum link gerado', async () => {
    db.billing_subscriptions![0]!.status = 'pending';
    const res = await req('/portal/connect', { method: 'POST', token: TOKEN_A });
    expect(res.status).toBe(402);
    expect(createHostedAuthLink).not.toHaveBeenCalled();
  });

  it('pago e sem conta: link do wizard para o tenant da SESSAO, nunca o do corpo', async () => {
    const res = await req('/portal/connect', {
      method: 'POST',
      token: TOKEN_A,
      body: { tenant_id: 'tB', account_id: 'ua-b' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({ url: 'https://wizard.example/xyz', reconnect: false });

    expect(db.connect_tokens).toHaveLength(1);
    expect(db.connect_tokens![0]).toMatchObject({ tenant_id: 'tA', purpose: 'create', status: 'pending' });
    expect(String(db.connect_tokens![0]!.token_hash)).toMatch(/^[0-9a-f]{64}$/);

    const enviado = vi.mocked(createHostedAuthLink).mock.calls[0]![1] as Record<string, unknown>;
    expect(enviado).toMatchObject({
      type: 'create',
      providers: ['LINKEDIN'],
      notify_url: 'https://api.example.workers.dev/hooks/connect',
      success_redirect_url: 'https://site.example/painel.html?conectado=1',
      single_use: true,
    });
    expect(String(enviado.name)).toMatch(/^lk_conn_[0-9a-f]{64}$/);
    expect(enviado).not.toHaveProperty('reconnect_account');
  });

  it('sessao caida: link de RECONEXAO da conta do proprio tenant, sem vazar o id', async () => {
    db.connected_accounts!.push({
      id: 'ca-a',
      tenant_id: 'tA',
      unipile_account_id: 'ua-a',
      provider: 'linkedin',
      status: 'disconnected',
      created_at: '2026-09-03T00:00:00.000Z',
    });
    const res = await req('/portal/connect', { method: 'POST', token: TOKEN_A });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('ua-a');
    expect(JSON.parse(text).data.reconnect).toBe(true);
    const enviado = vi.mocked(createHostedAuthLink).mock.calls[0]![1] as Record<string, unknown>;
    expect(enviado).toMatchObject({ type: 'reconnect', reconnect_account: 'ua-a' });
    expect(db.connect_tokens![0]).toMatchObject({ tenant_id: 'tA', purpose: 'reconnect' });
  });

  it('LinkedIn ja conectado: 409', async () => {
    const res = await req('/portal/connect', { method: 'POST', token: TOKEN_B });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_connected' });
  });

  it('I4: seats contam quem pagou e ainda vai conectar; acima do teto, 503 sem link', async () => {
    // tA (pago, sem conta) + tB (conta ativa) = 2 seats; teto 1.
    const res = await req('/portal/connect', { method: 'POST', token: TOKEN_A }, baseEnv({ SEAT_CAP: '1' }));
    expect(res.status).toBe(503);
    expect(createHostedAuthLink).not.toHaveBeenCalled();
    // No teto exato (2), o proprio tenant ja esta contado: segue.
    const ok = await req('/portal/connect', { method: 'POST', token: TOKEN_A }, baseEnv({ SEAT_CAP: '2' }));
    expect(ok.status).toBe(200);
  });

  it('sem PUBLIC_BASE_URL: 503 connect_unavailable (o notify nao teria para onde voltar)', async () => {
    const res = await req(
      '/portal/connect',
      { method: 'POST', token: TOKEN_A },
      baseEnv({ PUBLIC_BASE_URL: undefined }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'connect_unavailable' });
  });

  it('teto de links por tenant/dia: a 11a tentativa responde 429', async () => {
    const env = baseEnv();
    for (let i = 0; i < 10; i++) {
      const ok = await req('/portal/connect', { method: 'POST', token: TOKEN_A }, env);
      expect(ok.status).toBe(200);
    }
    const res = await req('/portal/connect', { method: 'POST', token: TOKEN_A }, env);
    expect(res.status).toBe(429);
  });
});

describe('POST /portal/key', () => {
  it('sem LinkedIn conectado: 409, nenhuma chave criada', async () => {
    const res = await req('/portal/key', { method: 'POST', token: TOKEN_A });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'linkedin_not_connected' });
    expect(db.api_keys).toHaveLength(1);
  });

  it('assinatura em atraso: 402', async () => {
    db.billing_subscriptions![1]!.status = 'overdue';
    const res = await req('/portal/key', { method: 'POST', token: TOKEN_B });
    expect(res.status).toBe(402);
  });

  it('gera a chave UMA vez, guarda so o hash e revoga so as chaves do proprio tenant', async () => {
    db.api_keys!.push({ id: 'k-a', tenant_id: 'tA', key_hash: 'hash-de-a', status: 'active', created_at: '2026-09-01T00:00:00.000Z' });
    const env = baseEnv();
    const res = await req(
      '/portal/key',
      // Tentativa de agir em outro tenant pelo corpo: ignorada.
      { method: 'POST', token: TOKEN_B, body: { tenant_id: 'tA' } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as { data: { api_key: string } };
    expect(body.data.api_key).toMatch(/^lk_live_[0-9a-f]{64}$/);

    const nova = db.api_keys!.find((k) => k.id !== 'k-b' && k.id !== 'k-a')!;
    expect(nova.tenant_id).toBe('tB');
    expect(nova.key_hash).toBe(await hashApiKey(body.data.api_key));
    expect(JSON.stringify(db.api_keys)).not.toContain(body.data.api_key);

    expect(db.api_keys!.find((k) => k.id === 'k-b')!.status).toBe('revoked');
    expect(db.api_keys!.find((k) => k.id === 'k-a')!.status).toBe('active');
    // A trava foi liberada no fim.
    expect(await env.RATE_LIMIT.get('portal:key:lock:tB')).toBeNull();
  });

  it('M2: com geracao em andamento para o tenant, 409 key_in_progress sem mexer nas chaves', async () => {
    const env = baseEnv();
    await env.RATE_LIMIT.put('portal:key:lock:tB', '1');
    const res = await req('/portal/key', { method: 'POST', token: TOKEN_B }, env);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'key_in_progress' });
    expect(db.api_keys).toHaveLength(1);
    expect(db.api_keys![0]!.status).toBe('active');
  });

  it('teto de chaves por tenant/dia: a 6a responde 429', async () => {
    const env = baseEnv();
    for (let i = 0; i < 5; i++) {
      expect((await req('/portal/key', { method: 'POST', token: TOKEN_B }, env)).status).toBe(200);
    }
    const res = await req('/portal/key', { method: 'POST', token: TOKEN_B }, env);
    expect(res.status).toBe(429);
  });
});

describe('PUT /portal/email (I2: corrigir erro de digitacao)', () => {
  it('antes do primeiro pagamento: corrige no Asaas E no banco, normalizado', async () => {
    db.billing_subscriptions![0]!.status = 'pending';
    const res = await req(
      '/portal/email',
      { method: 'PUT', token: TOKEN_A, body: { email: ' Certo@Example.com ' } },
      baseEnv({ ASAAS_API_KEY: 'asaas-key' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { email: 'certo@example.com' } });
    // O cliente do Asaas DESTE tenant (e para la que vao as faturas).
    expect(updateCustomerEmail).toHaveBeenCalledWith(expect.anything(), 'cus_A', 'certo@example.com');
    expect(db.tenants!.find((t) => t.id === 'tA')!.contact_email).toBe('certo@example.com');
    // So o tenant da sessao.
    expect(db.tenants!.find((t) => t.id === 'tB')!.contact_email).toBe('b@example.com');
  });

  it('F2.23: Asaas recusou a troca -> 502 e NADA muda no banco', async () => {
    db.billing_subscriptions![0]!.status = 'pending';
    vi.mocked(updateCustomerEmail).mockResolvedValueOnce(false);
    const res = await req(
      '/portal/email',
      { method: 'PUT', token: TOKEN_A, body: { email: 'novo@example.com' } },
      baseEnv({ ASAAS_API_KEY: 'asaas-key' }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'billing_unavailable' });
    expect(db.tenants!.find((t) => t.id === 'tA')!.contact_email).toBe('a@example.com');
  });

  it('depois do pagamento: 409 email_locked e nada muda', async () => {
    const res = await req('/portal/email', {
      method: 'PUT',
      token: TOKEN_A,
      body: { email: 'outro@example.com' },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'email_locked' });
    expect(db.tenants!.find((t) => t.id === 'tA')!.contact_email).toBe('a@example.com');
  });

  it('e-mail invalido: 400', async () => {
    db.billing_subscriptions![0]!.status = 'pending';
    const res = await req('/portal/email', { method: 'PUT', token: TOKEN_A, body: { email: 'x' } });
    expect(res.status).toBe(400);
  });
});

describe('webhook pelo painel (F2.26)', () => {
  it('PUT grava url https + secret NOVO so no tenant da sessao; GET nunca reexibe o secret', async () => {
    const env = baseEnv();
    const res = await req(
      '/portal/webhook',
      { method: 'PUT', token: TOKEN_A, body: { url: 'https://cliente-a.example/hook', tenant_id: 'tB' } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as { data: { url: string; secret: string } };
    expect(body.data.url).toBe('https://cliente-a.example/hook');
    expect(body.data.secret).toMatch(/^lk_whsec_[0-9a-f]{64}$/);
    const tA = db.tenants!.find((t) => t.id === 'tA')!;
    expect(tA.webhook_url).toBe('https://cliente-a.example/hook');
    expect(db.tenants!.find((t) => t.id === 'tB')!.webhook_url).toBeUndefined();

    const get = await req('/portal/webhook', { token: TOKEN_A }, env);
    const text = await get.text();
    expect(JSON.parse(text)).toEqual({
      ok: true,
      data: { url: 'https://cliente-a.example/hook', configured: true },
    });
    expect(text).not.toContain('lk_whsec_');
  });

  it.each(['http://cliente.example/hook', 'https://localhost/hook', 'https://10.0.0.1/hook', 'nao-e-url'])(
    'destino perigoso ou invalido (%s) e recusado',
    async (url) => {
      const res = await req('/portal/webhook', { method: 'PUT', token: TOKEN_A, body: { url } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_url' });
    },
  );

  it('DELETE remove url e secret', async () => {
    const env = baseEnv();
    await req('/portal/webhook', { method: 'PUT', token: TOKEN_A, body: { url: 'https://a.example/h' } }, env);
    const res = await req('/portal/webhook', { method: 'DELETE', token: TOKEN_A }, env);
    expect(res.status).toBe(200);
    const tA = db.tenants!.find((t) => t.id === 'tA')!;
    expect(tA.webhook_url).toBeNull();
    expect(tA.webhook_secret).toBeNull();
  });

  it('preflight libera DELETE para a landing', async () => {
    const res = await app.request(
      '/portal/webhook',
      { method: 'OPTIONS', headers: { Origin: 'https://landing-api-linkedin.vercel.app' } },
      baseEnv(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
  });
});

describe('POST /portal/logout', () => {
  it('revoga so a sessao usada; a proxima chamada com ela da 401', async () => {
    const env = baseEnv();
    const res = await req('/portal/logout', { method: 'POST', token: TOKEN_A }, env);
    expect(res.status).toBe(200);
    expect(db.portal_tokens!.find((t) => t.id === 'pt-a')!.status).toBe('revoked');
    expect(db.portal_tokens!.find((t) => t.id === 'pt-b')!.status).toBe('active');
    expect((await req('/portal/status', { token: TOKEN_A }, env)).status).toBe(401);
  });

  it('I1: sair de todos derruba todas as sessoes e links do tenant, e so dele', async () => {
    const outraSessao = `lk_portal_${'9'.repeat(64)}`;
    db.portal_tokens!.push({
      id: 'pt-a2',
      tenant_id: 'tA',
      token_hash: await hashApiKey(outraSessao),
      kind: 'session',
      status: 'active',
      expires_at: FUTURO,
    });
    const link = await linkDoTenant('tA');
    const env = baseEnv();

    const res = await req('/portal/logout', { method: 'POST', token: TOKEN_A, body: { all: true } }, env);
    expect(res.status).toBe(200);
    for (const t of db.portal_tokens!.filter((t) => t.tenant_id === 'tA')) {
      expect(t.status).toBe('revoked');
    }
    expect(db.portal_tokens!.find((t) => t.id === 'pt-b')!.status).toBe('active');
    expect((await req('/portal/status', { token: outraSessao }, env)).status).toBe(401);
    expect((await req('/portal/session', { method: 'POST', body: { token: link } }, env)).status).toBe(401);
  });
});

describe('POST /portal/login', () => {
  it('e-mail de cliente pago: envia LINK de uso unico que vira sessao (resposta generica)', async () => {
    const env = baseEnv();
    const res = await req('/portal/login', { method: 'POST', body: { email: '  A@Example.com ' } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1));
    const msg = vi.mocked(sendEmail).mock.calls[0]![1];
    expect(msg.to).toBe('a@example.com');
    const achado = msg.text.match(/https:\/\/site\.example\/painel\.html#t=(lk_plink_[0-9a-f]{64})/);
    expect(achado).not.toBeNull();

    const linkRow = db.portal_tokens!.find((t) => t.kind === 'link');
    expect(linkRow).toMatchObject({ tenant_id: 'tA', status: 'active' });
    expect(JSON.stringify(db.portal_tokens)).not.toContain(achado![1]);

    const troca = await req('/portal/session', { method: 'POST', body: { token: achado![1] } }, env);
    expect(troca.status).toBe(200);
  });

  it('e-mail desconhecido ou de quem nunca pagou: MESMA resposta, nada enviado', async () => {
    db.billing_subscriptions![1]!.status = 'pending';
    for (const email of ['ninguem@example.com', 'b@example.com']) {
      const res = await req('/portal/login', { method: 'POST', body: { email } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('sem e-mail configurado: 503 email_unavailable (a landing mostra o contato)', async () => {
    emailLigado = false;
    const res = await req('/portal/login', { method: 'POST', body: { email: 'a@example.com' } });
    expect(res.status).toBe(503);
  });

  it('content-type nao-json: 415; e-mail invalido: 400', async () => {
    const r1 = await req('/portal/login', {
      method: 'POST',
      body: 'email=a@example.com',
      contentType: 'text/plain',
    });
    expect(r1.status).toBe(415);
    const r2 = await req('/portal/login', { method: 'POST', body: { email: 'nao-e-email' } });
    expect(r2.status).toBe(400);
  });

  it('teto por e-mail: a caixa de ninguem e lotada (4a tentativa nao envia)', async () => {
    const env = baseEnv();
    for (let i = 0; i < 4; i++) {
      await req('/portal/login', { method: 'POST', body: { email: 'a@example.com' }, ip: `1.1.1.${i}` }, env);
    }
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });
});
