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
  createPixAutomaticAuthorization: vi.fn(async () => ({
    authorizationId: 'auth_123',
    qr: {
      image: 'BASE64IMG',
      code: '00020126PIXCOPIAECOLA',
      expires_at: '2026-09-04 23:59:59',
    },
  })),
  cancelPixAutomaticAuthorization: vi.fn(async () => true),
}));

import app from '../src/index';
import {
  createCustomer,
  createPixAutomaticAuthorization,
  cancelPixAutomaticAuthorization,
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
        method: 'pix_automatic',
        pix: {
          image: 'BASE64IMG',
          code: '00020126PIXCOPIAECOLA',
          expires_at: '2026-09-04 23:59:59',
        },
      },
    });
    expect(text).not.toContain(TENANT_ID);
    expect(text).not.toContain('cus_123');
    expect(text).not.toContain('auth_123');

    // Cliente (nao cobra) antes do tenant; autorizacao (cobra) depois dele.
    const chamadas = vi.mocked(createCustomer).mock.invocationCallOrder[0]!;
    const autorizacao = vi.mocked(createPixAutomaticAuthorization).mock.invocationCallOrder[0]!;
    expect(chamadas).toBeLessThan(autorizacao);
    expect(inserted.map((i) => i.table)).toEqual(['tenants', 'billing_subscriptions']);

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
    expect(vi.mocked(createPixAutomaticAuthorization).mock.calls).toHaveLength(1);
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
