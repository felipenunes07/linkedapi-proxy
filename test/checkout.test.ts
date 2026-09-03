import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../src/types';
import { memoryKV } from './helpers';

// Checkout proprio (F2.14): rota publica que cria tenant + cobranca.
// As camadas provadas aqui vieram do security review:
//   fail-closed (sem chave/KV), content-type (anti CSRF cross-site), throttle
//   em 3 eixos, modulo 11 do documento, lock de idempotencia, capacidade de
//   seats, ordem das operacoes e cancelamento da assinatura orfa.

const ASAAS_KEY = 'asaas-key-nunca-vaza';
const TENANT_ID = 'tenant-novo-uuid';
// CPF e CNPJ validos no modulo 11 (fixtures, nao pertencem a ninguem).
const CPF_OK = '529.982.247-25';
const CNPJ_OK = '11.222.333/0001-81';

const inserted: { table: string; row: Record<string, unknown> }[] = [];
let contasAtivas: { id: string }[] = [];

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(async (_env: Env, table: string) =>
    table === 'connected_accounts' ? contasAtivas : [],
  ),
  supabaseInsert: vi.fn(async (_env: Env, table: string, row: Record<string, unknown>) => {
    inserted.push({ table, row });
    if (table === 'tenants') return [{ id: TENANT_ID }];
    return [row];
  }),
  supabaseUpdate: vi.fn(async () => []),
  supabaseDelete: vi.fn(async () => undefined),
  supabaseRpc: vi.fn(async () => undefined),
}));

vi.mock('../src/lib/asaas', () => ({
  createCustomer: vi.fn(async () => 'cus_123'),
  createSubscription: vi.fn(async () => 'sub_123'),
  createCardSubscription: vi.fn(async () => ({
    subscriptionId: 'sub_card_123',
    lastDigits: '4242',
    brand: 'VISA',
  })),
  cancelSubscription: vi.fn(async () => true),
  firstPaymentId: vi.fn(async () => 'pay_123'),
  pixQrCode: vi.fn(async () => ({
    encodedImage: 'BASE64IMG',
    payload: '00020126PIXCOPIAECOLA',
    expirationDate: '2026-09-04 23:59:59',
  })),
}));

import app from '../src/index';
import {
  createCustomer,
  createSubscription,
  createCardSubscription,
  cancelSubscription,
} from '../src/lib/asaas';
import { supabaseInsert, supabaseDelete } from '../src/lib/supabase';

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

// Numero de cartao ficticio usado so nas assercoes de nao-vazamento.
const CARTAO_NUM = '5162306219378829';
const CCV = '318';

function corpoCartao(extra: Record<string, unknown> = {}) {
  return {
    ...BODY_OK,
    payment_method: 'card',
    card: {
      holder_name: 'MARIA SOUZA',
      number: CARTAO_NUM,
      expiry_month: '12',
      expiry_year: '2030',
      ccv: CCV,
    },
    holder: { postal_code: '80035-210', address_number: '103', phone: '41999998888' },
    ...extra,
  };
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
    expect(line).not.toContain(CARTAO_NUM);
    expect(line).not.toContain(CCV);
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

    expect(JSON.parse(text)).toEqual({
      ok: true,
      data: {
        value: 57,
        method: 'pix',
        pix: {
          image: 'BASE64IMG',
          code: '00020126PIXCOPIAECOLA',
          expires_at: '2026-09-04 23:59:59',
        },
      },
    });
    expect(text).not.toContain(TENANT_ID);
    expect(text).not.toContain('cus_123');
    expect(text).not.toContain('sub_123');

    // Cliente (nao cobra) antes do tenant; assinatura (cobra) depois dele.
    const chamadas = vi.mocked(createCustomer).mock.invocationCallOrder[0]!;
    const assinatura = vi.mocked(createSubscription).mock.invocationCallOrder[0]!;
    expect(chamadas).toBeLessThan(assinatura);
    expect(inserted.map((i) => i.table)).toEqual(['tenants', 'billing_subscriptions']);

    const vinculo = inserted[1];
    expect(vinculo).toBeDefined();
    expect(vinculo!.row).toMatchObject({
      tenant_id: TENANT_ID,
      asaas_subscription_id: 'sub_123',
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

describe('POST /checkout, cartao (cobranca automatica)', () => {
  it('cria assinatura no cartao e devolve so bandeira e 4 digitos', async () => {
    const res = await post(corpoCartao(), baseEnv());
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(JSON.parse(text)).toEqual({
      ok: true,
      data: { value: 57, method: 'card', card: { last_digits: '4242', brand: 'VISA' } },
    });
    // O numero e o CCV NUNCA voltam na resposta.
    expect(text).not.toContain(CARTAO_NUM);
    expect(text).not.toContain(CCV);

    // Foi pelo caminho do cartao, nao pelo Pix.
    expect(createCardSubscription).toHaveBeenCalledTimes(1);
    expect(createSubscription).not.toHaveBeenCalled();

    // O titular leva os dados exigidos pelo antifraude.
    const args = vi.mocked(createCardSubscription).mock.calls[0]![1];
    expect(args).toMatchObject({
      card: { number: CARTAO_NUM, expiryMonth: '12' },
      holder: { cpfCnpj: '52998224725', postalCode: '80035210', phone: '41999998888' },
    });
  });

  it('o vinculo gravado no banco nunca carrega dado de cartao', async () => {
    await post(corpoCartao(), baseEnv());
    const gravado = JSON.stringify(inserted);
    expect(gravado).not.toContain(CARTAO_NUM);
    expect(gravado).not.toContain(CCV);
    expect(gravado).not.toContain('MARIA SOUZA');
  });

  it.each([
    [{ number: '123' }, 'invalid_card_number'],
    [{ expiry_month: '13' }, 'invalid_card_expiry'],
    [{ expiry_year: '30' }, 'invalid_card_expiry'],
    [{ ccv: '1' }, 'invalid_card_ccv'],
    [{ holder_name: '' }, 'invalid_card_holder'],
  ] as const)('cartao invalido (%#) recusado sem tocar o Asaas', async (patch, erro) => {
    const base = corpoCartao();
    const res = await post(
      { ...base, card: { ...base.card, ...patch } },
      baseEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: erro });
    expect(createCardSubscription).not.toHaveBeenCalled();
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it.each([
    [{ postal_code: '123' }, 'invalid_postal_code'],
    [{ address_number: '' }, 'invalid_address_number'],
    [{ phone: '123' }, 'invalid_phone'],
  ] as const)('titular incompleto (%#) recusado', async (patch, erro) => {
    const base = corpoCartao();
    const res = await post(
      { ...base, holder: { ...base.holder, ...patch } },
      baseEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: erro });
    expect(createCardSubscription).not.toHaveBeenCalled();
  });

  it.each([
    // Luhn errado (digito verificador do cartao).
    [{ number: '4111111111111112' }, 'invalid_card_number'],
    // Validade no passado.
    [{ expiry_year: '2020' }, 'invalid_card_expiry'],
    // Ano absurdo.
    [{ expiry_year: '9999' }, 'invalid_card_expiry'],
  ] as const)('cartao com validade/Luhn ruim (%#) e barrado localmente', async (patch, erro) => {
    const base = corpoCartao();
    const res = await post({ ...base, card: { ...base.card, ...patch } }, baseEnv());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: erro });
    expect(createCardSubscription).not.toHaveBeenCalled();
  });

  it('mes/ano como numero (nao string) sao aceitos', async () => {
    const base = corpoCartao();
    const res = await post(
      { ...base, card: { ...base.card, expiry_month: 12, expiry_year: 2030 } },
      baseEnv(),
    );
    expect(res.status).toBe(200);
  });

  it('sem CF-Connecting-IP o remoteIp NAO vai como literal invalido', async () => {
    await post(corpoCartao(), baseEnv());
    const args = vi.mocked(createCardSubscription).mock.calls[0]![1];
    // Em teste nao ha header de IP: o campo deve ser null, nunca 'unknown'.
    expect(args.remoteIp).toBeNull();
  });

  it('recusa libera o lock: o cliente consegue tentar outro cartao na hora', async () => {
    const env = baseEnv();
    vi.mocked(createCardSubscription).mockRejectedValueOnce(
      new Error('asaas_card_failed:400'),
    );
    const recusado = await post(corpoCartao(), env);
    expect(recusado.status).toBe(402);

    // Mesmo e-mail e documento, outro cartao: nao pode cair em 409.
    const segunda = await post(corpoCartao(), env);
    expect(segunda.status).toBe(200);
  });

  it('tres recusas no mesmo IP travam o card testing', async () => {
    const env = baseEnv();
    for (let i = 0; i < 3; i++) {
      vi.mocked(createCardSubscription).mockRejectedValueOnce(
        new Error('asaas_card_failed:400'),
      );
      const res = await post(
        corpoCartao({ email: `t${i}@example.com`, cpf_cnpj: CNPJ_OK }),
        env,
        { ip: '7.7.7.7' },
      );
      expect(res.status).toBe(402);
    }
    const bloqueado = await post(
      corpoCartao({ email: 'quarto@example.com' }),
      env,
      { ip: '7.7.7.7' },
    );
    expect(bloqueado.status).toBe(429);
  });

  it('sem payment_method o padrao continua sendo Pix', async () => {
    const res = await post(BODY_OK, baseEnv());
    const json = (await res.json()) as { data: { method: string } };
    expect(json.data.method).toBe('pix');
    expect(createCardSubscription).not.toHaveBeenCalled();
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

  it('B3: falha ao gravar o vinculo CANCELA a assinatura no Asaas', async () => {
    vi.mocked(supabaseInsert).mockImplementationOnce(async () => [{ id: TENANT_ID }]);
    vi.mocked(supabaseInsert).mockRejectedValueOnce(
      new Error('supabase_insert_failed:500'),
    );
    const res = await post(BODY_OK, baseEnv());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'billing_unavailable' });
    expect(cancelSubscription).toHaveBeenCalledWith(expect.anything(), 'sub_123');
    // O id da assinatura fica no log para reconciliacao manual.
    const linhas = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(linhas.some((l) => l.includes('checkout_orphan_subscription'))).toBe(true);
  });

  it('I5: sem seat livre responde 503 sold_out, sem cobrar', async () => {
    contasAtivas = Array.from({ length: 10 }, (_, i) => ({ id: `ca-${i}` }));
    const res = await post(BODY_OK, baseEnv());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'sold_out' });
    expect(createCustomer).not.toHaveBeenCalled();
  });

  it('I1: segunda tentativa do mesmo cliente esbarra no lock (409)', async () => {
    const env = baseEnv();
    const primeira = await post(BODY_OK, env);
    expect(primeira.status).toBe(200);
    const segunda = await post(BODY_OK, env);
    expect(segunda.status).toBe(409);
    expect(await segunda.json()).toEqual({ error: 'checkout_in_progress' });
    expect(vi.mocked(createSubscription).mock.calls).toHaveLength(1);
  });

  it('I2: teto por documento corta a enumeracao mesmo trocando de IP', async () => {
    const env = baseEnv();
    // Mesmo documento, e-mails e IPs diferentes (escapa do lock e do teto/IP).
    for (let i = 0; i < 3; i++) {
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

  it('cartao recusado vira 402 e o tenant orfao e removido', async () => {
    vi.mocked(createCardSubscription).mockRejectedValueOnce(
      new Error('asaas_card_failed:400'),
    );
    const res = await post(corpoCartao(), baseEnv());
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'card_declined' });
    // Digitar o cartao errado nao pode deixar lixo no banco.
    expect(supabaseDelete).toHaveBeenCalledWith(expect.anything(), 'tenants', {
      id: `eq.${TENANT_ID}`,
    });
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
