import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../src/types';
import { memoryKV } from './helpers';

// Checkout proprio (F2.14, reformulado em F2.18): rota publica que cria
// tenant + autorizacao de Pix Automatico. Cartao NAO passa por aqui (fora do
// escopo PCI, ver decisoes). As camadas provadas vieram do security review:
//   fail-closed (sem chave/KV), content-type (anti CSRF cross-site), throttle
//   em 3 eixos, modulo 11 do documento, lock de idempotencia, capacidade de
//   seats, ordem das operacoes e cancelamento da autorizacao orfa.

const ASAAS_KEY = 'asaas-key-nunca-vaza';
const TENANT_ID = 'tenant-novo-uuid';
// CPF e CNPJ validos no modulo 11 (fixtures, nao pertencem a ninguem).
const CPF_OK = '529.982.247-25';
const CNPJ_OK = '11.222.333/0001-81';

const inserted: { table: string; row: Record<string, unknown> }[] = [];
let contasAtivas: { id: string; tenant_id?: string }[] = [];
let pendentesRecentes: { tenant_id: string }[] = [];
let filtroPendentes: Record<string, string> | null = null;
// F2.29: tokens de assento e tenants de origem (o grupo do assento adicional).
let seatTokens: Record<string, unknown>[] = [];
let tenantsRows: Record<string, unknown>[] = [];

// Vinculos gravados pelo checkout: o "banco" dos testes de nova tentativa.
const vinculos = () =>
  inserted.filter((i) => i.table === 'billing_subscriptions').map((i) => i.row);

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(async (_env: Env, table: string, filters: Record<string, string>) => {
    if (table === 'connected_accounts') return contasAtivas;
    if (
      table === 'billing_subscriptions' &&
      (filters.asaas_checkout_id || filters.asaas_authorization_id)
    ) {
      // Busca do checkout anterior pela ancora guardada no lock.
      return vinculos().filter(
        (r) =>
          (!filters.asaas_checkout_id ||
            `eq.${r.asaas_checkout_id}` === filters.asaas_checkout_id) &&
          (!filters.asaas_authorization_id ||
            `eq.${r.asaas_authorization_id}` === filters.asaas_authorization_id) &&
          `eq.${r.status}` === filters.status,
      );
    }
    if (table === 'billing_subscriptions' && filters.status === 'eq.pending') {
      filtroPendentes = filters;
      return pendentesRecentes;
    }
    if (table === 'portal_tokens') {
      return seatTokens.filter(
        (t) =>
          `eq.${t.token_hash}` === filters.token_hash &&
          (!filters.kind || `eq.${t.kind}` === filters.kind) &&
          (!filters.status || `eq.${t.status}` === filters.status),
      );
    }
    if (table === 'tenants') {
      return tenantsRows.filter(
        (t) =>
          `eq.${t.id}` === filters.id &&
          (!filters.status || `eq.${t.status}` === filters.status),
      );
    }
    return [];
  }),
  supabaseInsert: vi.fn(async (_env: Env, table: string, row: Record<string, unknown>) => {
    inserted.push({ table, row });
    if (table === 'tenants') return [{ id: TENANT_ID }];
    return [row];
  }),
  supabaseUpdate: vi.fn(
    async (
      _env: Env,
      table: string,
      filters: Record<string, string>,
      patch: Record<string, unknown>,
    ) => {
      if (table === 'portal_tokens') {
        // Consumo do token de assento: condicional (active -> used).
        const alvo = seatTokens.filter(
          (t) =>
            `eq.${t.token_hash}` === filters.token_hash &&
            `eq.${t.kind}` === filters.kind &&
            `eq.${t.status}` === filters.status &&
            (!filters.expires_at || String(t.expires_at) > filters.expires_at.slice(3)),
        );
        for (const t of alvo) Object.assign(t, patch);
        return alvo;
      }
      if (table !== 'billing_subscriptions') return [];
      const alvo = vinculos().filter(
        (r) =>
          `eq.${r.tenant_id}` === filters.tenant_id &&
          (!filters.status || `eq.${r.status}` === filters.status),
      );
      for (const r of alvo) Object.assign(r, patch);
      return alvo;
    },
  ),
  supabaseDelete: vi.fn(async () => undefined),
  supabaseRpc: vi.fn(async () => undefined),
}));

vi.mock('../src/lib/asaas', () => ({
  createCustomer: vi.fn(async () => 'cus_123'),
  createPixAutomaticAuthorization: vi.fn(async () => ({
    authorizationId: 'auth_123',
    qr: {
      image: 'BASE64IMG',
      code: '00020126PIXCOPIAECOLA',
      expires_at: '2026-09-04 23:59:59',
    },
  })),
  cancelPixAutomaticAuthorization: vi.fn(async () => true),
  createCardCheckout: vi.fn(async () => ({
    checkoutId: 'chk_123',
    url: 'https://asaas.com/checkoutSession/show?id=chk_123',
  })),
  cancelCardCheckout: vi.fn(async () => 'ok'),
  // Checkout anterior (nova tentativa): sem cobranca e QR ainda nao autorizado.
  listPayments: vi.fn(async () => []),
  pixAutomaticAuthorizationStatus: vi.fn(async () => 'CREATED'),
}));

import app from '../src/index';
import {
  createCustomer,
  createPixAutomaticAuthorization,
  cancelPixAutomaticAuthorization,
  createCardCheckout,
  cancelCardCheckout,
  listPayments,
  pixAutomaticAuthorizationStatus,
} from '../src/lib/asaas';
import { supabaseInsert, supabaseDelete, supabaseUpdate } from '../src/lib/supabase';
import { hashApiKey } from '../src/lib/hash';

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    UNIPILE_DSN: 'apiX.unipile.com:0000',
    UNIPILE_MASTER_TOKEN: 'master-token-nunca-vaza',
    SUPABASE_URL: 'https://fake.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-nunca-vaza',
    ASAAS_API_KEY: ASAAS_KEY,
    RATE_LIMIT: memoryKV(),
    ...overrides,
  } as Env;
}

const BODY_OK = { name: 'Maria Souza', email: 'maria@example.com', cpf_cnpj: CPF_OK };

// Cada teste usa um documento/e-mail diferentes quando precisa escapar do lock.
function corpo(extra: Partial<typeof BODY_OK> = {}) {
  return { ...BODY_OK, ...extra };
}

function post(
  body: unknown,
  env: Env,
  opts: { origin?: string; ip?: string; contentType?: string } = {},
) {
  return app.request(
    '/checkout',
    {
      method: 'POST',
      headers: {
        'content-type': opts.contentType ?? 'application/json',
        ...(opts.origin ? { Origin: opts.origin } : {}),
        ...(opts.ip ? { 'CF-Connecting-IP': opts.ip } : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    env,
  );
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  inserted.length = 0;
  contasAtivas = [];
  pendentesRecentes = [];
  filtroPendentes = null;
  seatTokens = [];
  tenantsRows = [];
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  // Nenhum sinal interno pode carregar a chave do Asaas, dado pessoal nem,
  // acima de tudo, dado de cartao (regra do caminho PCI).
  for (const call of errorSpy.mock.calls) {
    const line = String(call[0]);
    expect(line).not.toContain(ASAAS_KEY);
    expect(line).not.toContain('maria@example.com');
    expect(line).not.toContain('52998224725');
  }
  errorSpy.mockRestore();
});

describe('POST /checkout, portas de entrada', () => {
  it('sem ASAAS_API_KEY a rota nem existe (404)', async () => {
    const res = await post(BODY_OK, baseEnv({ ASAAS_API_KEY: undefined }));
    expect(res.status).toBe(404);
    expect(supabaseInsert).not.toHaveBeenCalled();
  });

  it('sem KV responde 500 sem tocar banco nem Asaas (fail-closed)', async () => {
    const res = await post(
      BODY_OK,
      baseEnv({ RATE_LIMIT: undefined as unknown as KVNamespace }),
    );
    expect(res.status).toBe(500);
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('B1: content-type nao-json e recusado (415) antes de qualquer escrita', async () => {
    const res = await post(BODY_OK, baseEnv(), { contentType: 'text/plain' });
    expect(res.status).toBe(415);
    expect(createCustomer).not.toHaveBeenCalled();
    expect(supabaseInsert).not.toHaveBeenCalled();
  });

  it('B1: Origin fora da allowlist e recusado (403), mesmo em POST simples', async () => {
    const res = await post(BODY_OK, baseEnv(), { origin: 'https://site-malicioso.com' });
    expect(res.status).toBe(403);
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('preflight de origem nao permitida: 403', async () => {
    const res = await app.request(
      '/checkout',
      { method: 'OPTIONS', headers: { Origin: 'https://site-malicioso.com' } },
      baseEnv(),
    );
    expect(res.status).toBe(403);
  });

  it('CORS: origem permitida recebe o header', async () => {
    const res = await post(BODY_OK, baseEnv(), {
      origin: 'https://linkedapi-site.pages.dev',
    });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://linkedapi-site.pages.dev',
    );
  });
});

describe('POST /checkout, validacao', () => {
  it.each([
    [corpo({ name: 'x' }), 'invalid_name'],
    [corpo({ email: 'nao-e-email' }), 'invalid_email'],
    [corpo({ cpf_cnpj: '123' }), 'invalid_document'],
    // Modulo 11: digito verificador errado (I3).
    [corpo({ cpf_cnpj: '111.111.111-11' }), 'invalid_document'],
    [corpo({ cpf_cnpj: '529.982.247-26' }), 'invalid_document'],
  ] as const)('corpo invalido (%#) recusado antes de tocar o Asaas', async (body, erro) => {
    const res = await post(body, baseEnv());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: erro });
    expect(createCustomer).not.toHaveBeenCalled();
    expect(supabaseInsert).not.toHaveBeenCalled();
  });

  it('JSON malformado: 400 sem tocar Asaas', async () => {
    const res = await post('{nao e json', baseEnv());
    expect(res.status).toBe(400);
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('CNPJ valido e aceito', async () => {
    const res = await post(corpo({ cpf_cnpj: CNPJ_OK }), baseEnv());
    expect(res.status).toBe(200);
  });
});

describe('POST /checkout, caminho feliz e ordem', () => {
  it('cria na ordem certa e devolve so o Pix', async () => {
    const res = await post(BODY_OK, baseEnv());
    expect(res.status).toBe(200);
    const text = await res.text();

    const body = JSON.parse(text);
    expect(body).toEqual({
      ok: true,
      data: {
        value: 67,
        method: 'pix_automatic',
        pix: {
          image: 'BASE64IMG',
          code: '00020126PIXCOPIAECOLA',
          expires_at: '2026-09-04 23:59:59',
        },
        portal: {
          token: expect.stringMatching(/^lk_portal_[0-9a-f]{64}$/),
          expires_at: expect.any(String),
        },
      },
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(text).not.toContain(TENANT_ID);
    expect(text).not.toContain('cus_123');
    expect(text).not.toContain('auth_123');

    // Cliente (nao cobra) antes do tenant; autorizacao (cobra) depois dele.
    const chamadas = vi.mocked(createCustomer).mock.invocationCallOrder[0]!;
    const autorizacao = vi.mocked(createPixAutomaticAuthorization).mock.invocationCallOrder[0]!;
    expect(chamadas).toBeLessThan(autorizacao);
    expect(inserted.map((i) => i.table)).toEqual([
      'tenants',
      'billing_subscriptions',
      'portal_tokens',
    ]);

    // F2.20: e-mail normalizado no tenant (e onde o "entrar no painel" busca).
    expect(inserted[0]!.row).toMatchObject({ contact_email: 'maria@example.com' });
    // Token do painel: do tenant novo, e SO o hash no banco.
    const tokenRow = inserted[2]!.row;
    expect(tokenRow).toMatchObject({ tenant_id: TENANT_ID, status: 'active' });
    expect(tokenRow.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(tokenRow)).not.toContain(body.data.portal.token);

    const vinculo = inserted[1];
    expect(vinculo).toBeDefined();
    expect(vinculo!.row).toMatchObject({
      tenant_id: TENANT_ID,
      asaas_authorization_id: 'auth_123',
      payment_method: 'pix_automatic',
      status: 'pending',
    });

    // B2: cliente do checkout publico NUNCA nasce com notificacao ligada.
    const argsCliente = vi.mocked(createCustomer).mock.calls[0]![1];
    expect(argsCliente).toMatchObject({
      cpfCnpj: '52998224725',
      notificationsEnabled: false,
    });
  });
});

describe('POST /checkout, cartao recorrente no checkout hospedado (F2.25)', () => {
  const envCartao = () => baseEnv({ PORTAL_URL: 'https://site.example/painel' } as Partial<Env>);

  it('cria sessao hospedada (sem cliente pre-criado) e devolve so a URL do Asaas', async () => {
    const res = await post({ ...BODY_OK, payment_method: 'card' }, envCartao());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.data).toMatchObject({
      method: 'card',
      checkout_url: 'https://asaas.com/checkoutSession/show?id=chk_123',
      portal: { token: expect.stringMatching(/^lk_portal_[0-9a-f]{64}$/) },
    });
    // Nenhum dado de cartao passa por aqui; nem QR de Pix.
    expect(body.data).not.toHaveProperty('pix');
    expect(createPixAutomaticAuthorization).not.toHaveBeenCalled();
    expect(text).not.toContain(TENANT_ID);
    expect(text).not.toContain('cus_123');

    const args = vi.mocked(createCardCheckout).mock.calls[0]![1];
    expect(args).toMatchObject({
      value: 67,
      externalReference: TENANT_ID,
      successUrl: 'https://site.example/painel?pagamento=cartao',
      cancelUrl: 'https://site.example/#assinar',
    });
    expect(args).not.toHaveProperty('customerId');
    // O Asaas nao aceita cliente pre-criado no checkout: nao criamos um.
    expect(createCustomer).not.toHaveBeenCalled();
    const vinculo = inserted.find((i) => i.table === 'billing_subscriptions')!;
    expect(vinculo.row).toMatchObject({
      tenant_id: TENANT_ID,
      asaas_customer_id: null,
      asaas_checkout_id: 'chk_123',
      payment_method: 'card',
      status: 'pending',
    });
  });

  it('#5: nova tentativa ENCERRA a sessao anterior (sem pagamento) e abre outra', async () => {
    const env = envCartao();
    const primeira = await post({ ...BODY_OK, payment_method: 'card' }, env);
    expect(primeira.status).toBe(200);
    const segunda = await post({ ...BODY_OK, payment_method: 'card' }, env);
    expect(segunda.status).toBe(200);
    const body = (await segunda.json()) as { data: Record<string, unknown> };
    // Sessao nova com painel proprio: nada de reaproveitar uma URL que o
    // cliente pode ter cancelado na pagina do Asaas.
    expect(body.data).toMatchObject({ method: 'card', portal: { token: expect.any(String) } });
    expect(createCardCheckout).toHaveBeenCalledTimes(2);
    expect(cancelCardCheckout).toHaveBeenCalledWith(expect.anything(), 'chk_123');
    expect(listPayments).toHaveBeenCalledWith(expect.anything(), { checkoutSession: 'chk_123' }, 1);
    // O vinculo anterior sai do "pendente" (libera o seat) e o novo nasce pendente.
    expect(vinculos().map((v) => v.status)).toEqual(['canceled', 'pending']);
  });

  it('#5: sessao anterior com cobranca, ou sem como conferir: 409 e nada novo', async () => {
    const env = envCartao();
    await post({ ...BODY_OK, payment_method: 'card' }, env);
    vi.mocked(listPayments).mockResolvedValueOnce([
      {
        id: 'pay_1',
        status: 'CONFIRMED',
        subscription: 'sub_1',
        customer: 'cus_1',
        checkoutSession: 'chk_123',
        dueDate: null,
      },
    ]);
    const paga = await post({ ...BODY_OK, payment_method: 'card' }, env);
    expect(paga.status).toBe(409);
    vi.mocked(listPayments).mockResolvedValueOnce(null);
    const indefinida = await post({ ...BODY_OK, payment_method: 'card' }, env);
    expect(indefinida.status).toBe(409);
    expect(createCardCheckout).toHaveBeenCalledTimes(1);
    expect(vinculos().map((v) => v.status)).toEqual(['pending']);
  });

  it('#5: trocar de Pix para cartao cancela a autorizacao pendente antes', async () => {
    const env = envCartao();
    await post(BODY_OK, env);
    const cartao = await post({ ...BODY_OK, payment_method: 'card' }, env);
    expect(cartao.status).toBe(200);
    expect(listPayments).toHaveBeenCalledWith(expect.anything(), { customer: 'cus_123' }, 10);
    expect(cancelPixAutomaticAuthorization).toHaveBeenCalledWith(expect.anything(), 'auth_123');
    expect(vinculos().map((v) => [v.payment_method, v.status])).toEqual([
      ['pix_automatic', 'canceled'],
      ['card', 'pending'],
    ]);
  });

  it('F2.27: cancelar a sessao anterior ficou sem resposta do Asaas: 409, nada novo', async () => {
    const env = envCartao();
    await post({ ...BODY_OK, payment_method: 'card' }, env);
    vi.mocked(cancelCardCheckout).mockResolvedValueOnce('falhou');
    const res = await post({ ...BODY_OK, payment_method: 'card' }, env);
    expect(res.status).toBe(409);
    expect(createCardCheckout).toHaveBeenCalledTimes(1);
    expect(vinculos().map((v) => v.status)).toEqual(['pending']);
  });

  it('F2.27: o webhook ativou o vinculo anterior no meio do caminho: 409, nada novo', async () => {
    const env = envCartao();
    await post({ ...BODY_OK, payment_method: 'card' }, env);
    vi.mocked(supabaseUpdate).mockResolvedValueOnce([]);
    const res = await post({ ...BODY_OK, payment_method: 'card' }, env);
    expect(res.status).toBe(409);
    expect(createCardCheckout).toHaveBeenCalledTimes(1);
  });

  it('falha ao gravar o vinculo CANCELA a sessao de cartao e remove o tenant orfao', async () => {
    vi.mocked(supabaseInsert).mockImplementationOnce(async () => [{ id: TENANT_ID }]);
    vi.mocked(supabaseInsert).mockRejectedValueOnce(new Error('supabase_insert_failed:500'));
    const res = await post({ ...BODY_OK, payment_method: 'card' }, envCartao());
    expect(res.status).toBe(502);
    expect(cancelCardCheckout).toHaveBeenCalledWith(expect.anything(), 'chk_123');
    expect(supabaseDelete).toHaveBeenCalledWith(expect.anything(), 'tenants', {
      id: `eq.${TENANT_ID}`,
    });
  });

  it('Asaas recusou a sessao: 502, tenant orfao removido, nada cobrado', async () => {
    vi.mocked(createCardCheckout).mockRejectedValueOnce(new Error('asaas_card_checkout_failed:400'));
    const res = await post({ ...BODY_OK, payment_method: 'card' }, envCartao());
    expect(res.status).toBe(502);
    expect(supabaseDelete).toHaveBeenCalled();
  });

  it('metodo desconhecido e recusado antes de tocar em qualquer coisa', async () => {
    const res = await post({ ...BODY_OK, payment_method: 'boleto' }, envCartao());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_payment_method' });
    expect(createCustomer).not.toHaveBeenCalled();
  });
});

describe('POST /checkout, falhas e abusos', () => {
  it('documento recusado pelo Asaas vira 400 generico', async () => {
    vi.mocked(createCustomer).mockRejectedValueOnce(
      new Error('asaas_customer_failed:400'),
    );
    const res = await post(BODY_OK, baseEnv());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_document' });
    // Nao chegou a criar tenant.
    expect(inserted).toHaveLength(0);
  });

  it('B3: falha ao gravar o vinculo CANCELA a autorizacao no Asaas', async () => {
    vi.mocked(supabaseInsert).mockImplementationOnce(async () => [{ id: TENANT_ID }]);
    vi.mocked(supabaseInsert).mockRejectedValueOnce(
      new Error('supabase_insert_failed:500'),
    );
    const res = await post(BODY_OK, baseEnv());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'billing_unavailable' });
    expect(cancelPixAutomaticAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      'auth_123',
    );
    // O id da autorizacao fica no log para reconciliacao manual.
    const linhas = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(linhas.some((l) => l.includes('checkout_orphan_authorization'))).toBe(true);
    // Sem vinculo a faxina nunca acharia o tenant: sai na hora.
    expect(supabaseDelete).toHaveBeenCalledWith(expect.anything(), 'tenants', {
      id: `eq.${TENANT_ID}`,
    });
  });

  it('F2.20: falha ao criar o token do painel NAO desfaz a venda', async () => {
    vi.mocked(supabaseInsert).mockImplementationOnce(async () => [{ id: TENANT_ID }]);
    vi.mocked(supabaseInsert).mockImplementationOnce(async () => []);
    vi.mocked(supabaseInsert).mockRejectedValueOnce(new Error('supabase_insert_failed:500'));
    const res = await post(BODY_OK, baseEnv());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { portal: unknown; pix: unknown } };
    expect(body.data.portal).toBeNull();
    expect(body.data.pix).not.toBeNull();
    expect(cancelPixAutomaticAuthorization).not.toHaveBeenCalled();
  });

  it('I5: sem seat livre responde 503 sold_out, sem cobrar', async () => {
    contasAtivas = Array.from({ length: 10 }, (_, i) => ({ id: `ca-${i}`, tenant_id: `t-${i}` }));
    const res = await post(BODY_OK, baseEnv());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'sold_out' });
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('F2.23: checkouts pendentes dentro da validade do Pix seguram vaga', async () => {
    contasAtivas = Array.from({ length: 6 }, (_, i) => ({ id: `ca-${i}`, tenant_id: `t-${i}` }));
    pendentesRecentes = Array.from({ length: 4 }, (_, i) => ({ tenant_id: `p-${i}` }));
    const res = await post(BODY_OK, baseEnv());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'sold_out' });
    expect(createCustomer).not.toHaveBeenCalled();
    // So conta pendente recente (criado dentro da ultima hora).
    const desde = Date.parse(String(filtroPendentes?.created_at).replace(/^gt\./, ''));
    expect(Date.now() - desde).toBeGreaterThan(55 * 60 * 1000);
    expect(Date.now() - desde).toBeLessThan(65 * 60 * 1000);
  });

  it('I1: Pix ja autorizado, ou sem resposta do Asaas: nova tentativa esbarra no lock (409)', async () => {
    const env = baseEnv();
    const primeira = await post(BODY_OK, env);
    expect(primeira.status).toBe(200);
    vi.mocked(pixAutomaticAuthorizationStatus).mockResolvedValueOnce('ACTIVE');
    const segunda = await post(BODY_OK, env);
    expect(segunda.status).toBe(409);
    expect(await segunda.json()).toEqual({ error: 'checkout_in_progress' });
    vi.mocked(pixAutomaticAuthorizationStatus).mockResolvedValueOnce(null);
    expect((await post(BODY_OK, env)).status).toBe(409);
    expect(vi.mocked(createPixAutomaticAuthorization).mock.calls).toHaveLength(1);
    expect(cancelPixAutomaticAuthorization).not.toHaveBeenCalled();
  });

  it('I1: QR ainda nao autorizado: nova tentativa cancela o anterior e gera outro', async () => {
    const env = baseEnv();
    await post(BODY_OK, env);
    const segunda = await post(BODY_OK, env);
    expect(segunda.status).toBe(200);
    expect(cancelPixAutomaticAuthorization).toHaveBeenCalledWith(expect.anything(), 'auth_123');
    expect(vi.mocked(createPixAutomaticAuthorization).mock.calls).toHaveLength(2);
  });

  it('F2.27: quem ja esgotou o teto do dia nao perde o checkout vivo (429 antes de encerrar)', async () => {
    const env = baseEnv();
    for (let i = 0; i < 5; i++) {
      expect((await post(BODY_OK, env)).status).toBe(200);
    }
    const sexta = await post(BODY_OK, env);
    expect(sexta.status).toBe(429);
    // As tentativas 2 a 5 encerraram a anterior; a 6a nao tocou no QR vivo.
    expect(cancelPixAutomaticAuthorization).toHaveBeenCalledTimes(4);
    const todos = vinculos();
    expect(todos[todos.length - 1]!.status).toBe('pending');
  });

  it('requisicao ainda em andamento para os mesmos dados: 409 sem tocar no Asaas', async () => {
    const env = baseEnv();
    const chave = `checkout:lock:${await hashApiKey('maria@example.com|52998224725')}`;
    await env.RATE_LIMIT.put(chave, '1');
    const res = await post(BODY_OK, env);
    expect(res.status).toBe(409);
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('I2: teto por documento corta a enumeracao mesmo trocando de IP', async () => {
    const env = baseEnv();
    // Mesmo documento, e-mails e IPs diferentes (escapa do lock e do teto/IP).
    for (let i = 0; i < 5; i++) {
      const res = await post(corpo({ email: `p${i}@example.com` }), env, {
        ip: `1.2.3.${i}`,
      });
      expect(res.status).toBe(200);
    }
    const bloqueado = await post(corpo({ email: 'p9@example.com' }), env, {
      ip: '1.2.3.9',
    });
    expect(bloqueado.status).toBe(429);
  });

  it('throttle por IP: acima do teto responde 429', async () => {
    const env = baseEnv();
    for (let i = 0; i < 10; i++) {
      await post(corpo({ email: `ip${i}@example.com`, cpf_cnpj: CNPJ_OK }), env, {
        ip: '9.9.9.9',
      });
    }
    const res = await post(corpo({ email: 'ultimo@example.com' }), env, {
      ip: '9.9.9.9',
    });
    expect(res.status).toBe(429);
  });

  it('IP abusivo NAO consome o teto global (nao derruba as vendas do dia)', async () => {
    const env = baseEnv();
    // 30 tentativas de um IP so: as 20 ultimas ja sao barradas por IP e nao
    // podem contar no contador global.
    for (let i = 0; i < 30; i++) {
      await post(corpo({ email: `abuso${i}@example.com`, cpf_cnpj: CNPJ_OK }), env, {
        ip: '6.6.6.6',
      });
    }
    // Cliente legitimo, outro IP e outro documento: tem que passar.
    const vitima = await post(
      corpo({ email: 'cliente.real@example.com', cpf_cnpj: CPF_OK }),
      env,
      { ip: '5.5.5.5' },
    );
    expect(vitima.status).toBe(200);
  });
});

// F2.29: o MESMO checkout vende o assento adicional. O que estes testes
// seguram: o token de assento (uso unico, autenticado no painel) e a unica
// coisa que poe o tenant novo num grupo, e a segunda compra NAO encerra a
// venda que o cliente ja tem de pe (o lock passa a ser por intencao).
describe('POST /checkout, assento adicional (F2.29)', () => {
  const SEAT_TOKEN = `lk_seat_${'c'.repeat(64)}`;

  beforeEach(async () => {
    seatTokens = [
      {
        id: 'st-1',
        tenant_id: 'tenant-origem',
        token_hash: await hashApiKey(SEAT_TOKEN),
        kind: 'seat',
        status: 'active',
        expires_at: '2099-01-01T00:00:00.000Z',
      },
    ];
    tenantsRows = [
      { id: 'tenant-origem', name: 'Maria Souza', group_id: null, status: 'active', created_at: '2026-09-01T00:00:00.000Z' },
    ];
  });

  it('com seat_token valido: tenant novo nasce no grupo, token vira usado e a origem entra no grupo', async () => {
    const res = await post(corpo({ seat_token: SEAT_TOKEN } as never), baseEnv());
    expect(res.status).toBe(200);

    const tenant = inserted.find((i) => i.table === 'tenants')!;
    expect(tenant.row.group_id).toBe('tenant-origem');
    expect(seatTokens[0]!.status).toBe('used');
    // A origem tambem passa a carregar o grupo, senao a lista so veria o novo.
    expect(supabaseUpdate).toHaveBeenCalledWith(
      expect.anything(),
      'tenants',
      { id: 'eq.tenant-origem', group_id: 'is.null' },
      { group_id: 'tenant-origem' },
    );
  });

  it('o segundo assento NAO encerra a venda que o cliente ja tem (lock por intencao)', async () => {
    const env = baseEnv();
    const primeira = await post(BODY_OK, env);
    expect(primeira.status).toBe(200);
    vi.mocked(cancelPixAutomaticAuthorization).mockClear();

    // Mesmo e-mail e mesmo CPF: sem o token, isto cairia no lock da primeira
    // venda e a encerraria (review F2.25, #5).
    const segunda = await post(corpo({ seat_token: SEAT_TOKEN } as never), env);
    expect(segunda.status).toBe(200);
    expect(cancelPixAutomaticAuthorization).not.toHaveBeenCalled();
    expect(inserted.filter((i) => i.table === 'tenants')).toHaveLength(2);
  });

  it('token usado, vencido, de tenant apagado ou inventado: 401 sem criar nada', async () => {
    seatTokens[0]!.status = 'used';
    const usado = await post(corpo({ seat_token: SEAT_TOKEN } as never), baseEnv());
    expect(usado.status).toBe(401);
    expect(await usado.json()).toEqual({ error: 'invalid_seat_token' });
    expect(inserted).toHaveLength(0);
    expect(createCustomer).not.toHaveBeenCalled();

    seatTokens[0]!.status = 'active';
    seatTokens[0]!.expires_at = '2000-01-01T00:00:00.000Z';
    const vencido = await post(corpo({ seat_token: SEAT_TOKEN, email: 'outra@example.com' } as never), baseEnv());
    expect(vencido.status).toBe(401);

    seatTokens = [];
    const inventado = await post(corpo({ seat_token: `lk_seat_${'d'.repeat(64)}` } as never), baseEnv());
    expect(inventado.status).toBe(401);
    expect(inserted).toHaveLength(0);
  });

  it('seat_token fora do formato: 400, antes de qualquer escrita', async () => {
    const res = await post(corpo({ seat_token: 'nao-e-token' } as never), baseEnv());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_seat_token' });
    expect(inserted).toHaveLength(0);
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('sem seat_token nada muda: o tenant nasce sem grupo', async () => {
    const res = await post(BODY_OK, baseEnv());
    expect(res.status).toBe(200);
    const tenant = inserted.find((i) => i.table === 'tenants')!;
    expect(tenant.row).not.toHaveProperty('group_id');
  });
});
