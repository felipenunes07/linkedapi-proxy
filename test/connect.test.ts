import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '../src/types';

// Callback da auto-conexao (Marco 4): POST /hooks/connect e a UNICA rota
// publica que escreve no banco. Estes testes provam as camadas da barreira:
//   1. throttle (KV, fail-closed) por token e por IP;
//   2. consumo ATOMICO do token (pending -> used) antes de qualquer escrita:
//      replay/reuso morre com 401;
//   3. purpose do token amarrado ao status do notify (create != reconnect);
//   4. verificacao upstream: conta existe, e LINKEDIN e (no create) carrega o
//      nosso token no campo name; reconnect SO reativa conta do proprio tenant;
//   5. conflito cross-tenant nunca re-vincula e nao vira oraculo.
// Data layer e Unipile mockados; o hash do token e o real (mesmo do Worker).

const TOKEN_A = 'lk_conn_token_pendente_create_tA';
const TOKEN_R = 'lk_conn_token_pendente_reconnect_tA';
const TOKEN_EXPIRADO = 'lk_conn_token_expirado';
const TOKEN_USADO = 'lk_conn_token_ja_usado';
const UA_NOVA = 'unipile-acct-nova';
const UA_ANTIGA = 'unipile-acct-antiga-do-tenant-A';
const UA_DE_B = 'unipile-acct-do-tenant-B';
const UA_DE_A = 'unipile-acct-ja-do-tenant-A';

import { hashApiKey } from '../src/lib/hash';
import { memoryKV } from './helpers';

// Estado em memoria por teste (os mocks leem/escrevem aqui).
interface Row {
  [key: string]: unknown;
}
const db: { connect_tokens: Row[]; connected_accounts: Row[] } = {
  connect_tokens: [],
  connected_accounts: [],
};

// Interpreta os operadores PostgREST usados pelo codigo: eq., gt., in.().
function matches(row: Row, filters: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'select' || key === 'limit' || key === 'order') continue;
    const field = String(row[key]);
    if (value.startsWith('eq.')) {
      if (field !== value.slice(3)) return false;
    } else if (value.startsWith('gt.')) {
      if (!(field > value.slice(3))) return false;
    } else if (value.startsWith('in.(')) {
      if (!value.slice(4, -1).split(',').includes(field)) return false;
    } else {
      throw new Error(`filtro nao suportado no mock: ${key}=${value}`);
    }
  }
  return true;
}

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(
    async (_env: Env, table: string, filters: Record<string, string>) =>
      (db[table as keyof typeof db] ?? []).filter((r) => matches(r, filters)),
  ),
  supabaseInsert: vi.fn(
    async (_env: Env, table: string, row: Record<string, unknown>) => {
      if (table === 'connected_accounts') {
        const ua = row.unipile_account_id;
        if (db.connected_accounts.some((a) => a.unipile_account_id === ua)) {
          throw new Error('supabase_insert_failed:409'); // unique da migration 0002
        }
        const created = { id: `ca-${db.connected_accounts.length + 1}`, ...row };
        db.connected_accounts.push(created);
        return [created];
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
      const rows = (db[table as keyof typeof db] ?? []).filter((r) =>
        matches(r, filters),
      );
      for (const row of rows) Object.assign(row, patch);
      return rows.map((r) => ({ ...r }));
    },
  ),
}));

vi.mock('../src/lib/unipile', () => ({
  getAccount: vi.fn(),
}));

import app from '../src/index';
import { getAccount } from '../src/lib/unipile';
import { supabaseInsert } from '../src/lib/supabase';

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

let env: Env;
let errorSpy: ReturnType<typeof vi.spyOn>;

function notify(body: unknown, e: Env = env) {
  return app.request(
    '/hooks/connect',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    e,
  );
}

function linkedinAccount(name: string): Response {
  return new Response(JSON.stringify({ id: 'x', type: 'LINKEDIN', name }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const FUTURO = '2099-01-01T00:00:00.000Z';
const PASSADO = '2000-01-01T00:00:00.000Z';

function tokenRow(id: string): Row | undefined {
  return db.connect_tokens.find((t) => t.id === id);
}
function accountRow(ua: string): Row | undefined {
  return db.connected_accounts.find((a) => a.unipile_account_id === ua);
}

beforeEach(async () => {
  env = baseEnv();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(getAccount).mockReset();
  vi.mocked(supabaseInsert).mockClear();
  db.connect_tokens = [
    {
      id: 'tok-A',
      tenant_id: 'tA',
      purpose: 'create',
      status: 'pending',
      expires_at: FUTURO,
      token_hash: await hashApiKey(TOKEN_A),
    },
    {
      id: 'tok-R',
      tenant_id: 'tA',
      purpose: 'reconnect',
      status: 'pending',
      expires_at: FUTURO,
      token_hash: await hashApiKey(TOKEN_R),
    },
    {
      id: 'tok-exp',
      tenant_id: 'tA',
      purpose: 'create',
      status: 'pending',
      expires_at: PASSADO,
      token_hash: await hashApiKey(TOKEN_EXPIRADO),
    },
    {
      id: 'tok-used',
      tenant_id: 'tA',
      purpose: 'create',
      status: 'used',
      expires_at: FUTURO,
      token_hash: await hashApiKey(TOKEN_USADO),
    },
  ];
  db.connected_accounts = [
    { id: 'ca-b', tenant_id: 'tB', unipile_account_id: UA_DE_B, status: 'active' },
    { id: 'ca-a', tenant_id: 'tA', unipile_account_id: UA_DE_A, status: 'disconnected' },
  ];
});

afterEach(() => {
  // Nenhum sinal interno pode carregar token em claro nem account_id.
  for (const call of errorSpy.mock.calls) {
    const line = String(call[0]);
    expect(line).not.toContain('lk_conn_');
    expect(line).not.toContain('unipile-acct');
  }
  errorSpy.mockRestore();
});

describe('POST /hooks/connect (create)', () => {
  it('notify valido vincula a conta ao tenant do token e consome o token', async () => {
    vi.mocked(getAccount).mockResolvedValue(linkedinAccount(TOKEN_A));
    const res = await notify({
      status: 'CREATION_SUCCESS',
      account_id: UA_NOVA,
      name: TOKEN_A,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true });
    expect(text).not.toContain(UA_NOVA); // nada interno ecoa

    expect(accountRow(UA_NOVA)).toMatchObject({ tenant_id: 'tA', status: 'active' });
    expect(tokenRow('tok-A')?.status).toBe('used');
  });

  it('1 seat = 1 conta: desativa a conta ativa anterior do tenant ao vincular a nova', async () => {
    db.connected_accounts.push({
      id: 'ca-old',
      tenant_id: 'tA',
      unipile_account_id: UA_ANTIGA,
      status: 'active',
    });
    vi.mocked(getAccount).mockResolvedValue(linkedinAccount(TOKEN_A));
    const res = await notify({
      status: 'CREATION_SUCCESS',
      account_id: UA_NOVA,
      name: TOKEN_A,
    });
    expect(res.status).toBe(200);
    expect(accountRow(UA_ANTIGA)?.status).toBe('disconnected');
    expect(accountRow(UA_NOVA)?.status).toBe('active');
  });

  it('conta cujo name nao e o token (ex.: conectada manualmente): 401, nada e gravado', async () => {
    vi.mocked(getAccount).mockResolvedValue(linkedinAccount('Victor Baggio'));
    const res = await notify({
      status: 'CREATION_SUCCESS',
      account_id: UA_NOVA,
      name: TOKEN_A,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'account_verification_failed' });
    expect(accountRow(UA_NOVA)).toBeUndefined();
    // Token queimado mesmo assim (comportamento seguro: operador gera outro).
    expect(tokenRow('tok-A')?.status).toBe('used');
  });

  it('conta ja vinculada a OUTRO tenant: resposta generica, nunca re-vincula, sinal interno', async () => {
    vi.mocked(getAccount).mockResolvedValue(linkedinAccount(TOKEN_A));
    const res = await notify({
      status: 'CREATION_SUCCESS',
      account_id: UA_DE_B,
      name: TOKEN_A,
    });
    // Mesma resposta do sucesso: sem oraculo de "essa conta existe e e de outro".
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(accountRow(UA_DE_B)?.tenant_id).toBe('tB');
    expect(supabaseInsert).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('connect_account_conflict'))).toBe(true);
  });

  it('re-emissao legitima (conta ja do MESMO tenant): reativa, idempotente', async () => {
    vi.mocked(getAccount).mockResolvedValue(linkedinAccount(TOKEN_A));
    const res = await notify({
      status: 'CREATION_SUCCESS',
      account_id: UA_DE_A,
      name: TOKEN_A,
    });
    expect(res.status).toBe(200);
    expect(accountRow(UA_DE_A)).toMatchObject({ tenant_id: 'tA', status: 'active' });
    expect(supabaseInsert).not.toHaveBeenCalled();
  });

  it('verificacao upstream falhou (conta nao existe na conta-mestra): 401, nada e gravado', async () => {
    vi.mocked(getAccount).mockResolvedValue(new Response('{}', { status: 404 }));
    const res = await notify({
      status: 'CREATION_SUCCESS',
      account_id: UA_NOVA,
      name: TOKEN_A,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'account_verification_failed' });
    expect(accountRow(UA_NOVA)).toBeUndefined();
  });

  it('conta de outro provedor (nao LINKEDIN): 401, nada e gravado', async () => {
    vi.mocked(getAccount).mockResolvedValue(
      new Response(JSON.stringify({ type: 'WHATSAPP', name: TOKEN_A }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const res = await notify({
      status: 'CREATION_SUCCESS',
      account_id: UA_NOVA,
      name: TOKEN_A,
    });
    expect(res.status).toBe(401);
    expect(accountRow(UA_NOVA)).toBeUndefined();
  });
});

describe('POST /hooks/connect (reconnect)', () => {
  it('reconexao valida reativa a conta do proprio tenant', async () => {
    vi.mocked(getAccount).mockResolvedValue(linkedinAccount('Fulano'));
    const res = await notify({
      status: 'RECONNECTED',
      account_id: UA_DE_A,
      name: TOKEN_R,
    });
    expect(res.status).toBe(200);
    expect(accountRow(UA_DE_A)).toMatchObject({ tenant_id: 'tA', status: 'active' });
    expect(tokenRow('tok-R')?.status).toBe('used');
    expect(supabaseInsert).not.toHaveBeenCalled();
  });

  it('reconexao NUNCA vincula conta nova nem de outro tenant: 401', async () => {
    vi.mocked(getAccount).mockResolvedValue(linkedinAccount('Fulano'));
    const res = await notify({
      status: 'RECONNECTED',
      account_id: UA_DE_B, // conta do tenant B
      name: TOKEN_R, // token do tenant A
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'account_verification_failed' });
    expect(accountRow(UA_DE_B)?.tenant_id).toBe('tB');
    expect(accountRow(UA_DE_B)?.status).toBe('active');
    expect(supabaseInsert).not.toHaveBeenCalled();
  });

  it('conta pausada (inadimplencia) NAO reativa por reconexao; resposta generica', async () => {
    accountRow(UA_DE_A)!.status = 'paused';
    vi.mocked(getAccount).mockResolvedValue(linkedinAccount('Fulano'));
    const res = await notify({
      status: 'RECONNECTED',
      account_id: UA_DE_A,
      name: TOKEN_R,
    });
    expect(res.status).toBe(200);
    expect(accountRow(UA_DE_A)?.status).toBe('paused');
  });
});

describe('POST /hooks/connect (token e proposito)', () => {
  it('token inexistente: 401, nada e gravado', async () => {
    const res = await notify({
      status: 'CREATION_SUCCESS',
      account_id: UA_NOVA,
      name: 'lk_conn_token_que_nao_existe',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
    expect(accountRow(UA_NOVA)).toBeUndefined();
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('token expirado: 401', async () => {
    const res = await notify({
      status: 'CREATION_SUCCESS',
      account_id: UA_NOVA,
      name: TOKEN_EXPIRADO,
    });
    expect(res.status).toBe(401);
    expect(accountRow(UA_NOVA)).toBeUndefined();
  });

  it('token ja usado (uso unico, replay): 401', async () => {
    const res = await notify({
      status: 'CREATION_SUCCESS',
      account_id: UA_NOVA,
      name: TOKEN_USADO,
    });
    expect(res.status).toBe(401);
    expect(accountRow(UA_NOVA)).toBeUndefined();
  });

  it('token create com status RECONNECTED (proposito trocado): 401 e token queimado', async () => {
    vi.mocked(getAccount).mockResolvedValue(linkedinAccount(TOKEN_A));
    const res = await notify({
      status: 'RECONNECTED',
      account_id: UA_DE_A,
      name: TOKEN_A,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
    expect(tokenRow('tok-A')?.status).toBe('used');
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('token reconnect com status CREATION_SUCCESS (proposito trocado): 401', async () => {
    const res = await notify({
      status: 'CREATION_SUCCESS',
      account_id: UA_NOVA,
      name: TOKEN_R,
    });
    expect(res.status).toBe(401);
    expect(accountRow(UA_NOVA)).toBeUndefined();
  });
});

describe('POST /hooks/connect (validacao e protecao)', () => {
  it('status desconhecido: confirma recebimento sem efeito e sem consumir token', async () => {
    const res = await notify({
      status: 'CREATION_FAILED',
      account_id: UA_NOVA,
      name: TOKEN_A,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ignored: true });
    expect(tokenRow('tok-A')?.status).toBe('pending');
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('payload sem name: 400', async () => {
    const res = await notify({ status: 'CREATION_SUCCESS', account_id: UA_NOVA });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_name' });
  });

  it('name acima do teto de tamanho: 400 (nao hasheia payload gigante)', async () => {
    const res = await notify({
      status: 'CREATION_SUCCESS',
      account_id: UA_NOVA,
      name: 'x'.repeat(201),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_name' });
  });

  it('payload sem account_id: 400', async () => {
    const res = await notify({ status: 'CREATION_SUCCESS', name: TOKEN_A });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_account_id' });
  });

  it('JSON malformado: 400', async () => {
    const res = await notify('nao-e-json{');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });

  it('throttle por token: corta com 429 apos o teto de tentativas', async () => {
    const body = {
      status: 'CREATION_SUCCESS',
      account_id: UA_NOVA,
      name: 'lk_conn_token_que_nao_existe',
    };
    for (let i = 0; i < 5; i++) {
      expect((await notify(body)).status).toBe(401);
    }
    const res = await notify(body);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
  });

  it('sem binding de KV: recusa com 500 (nao opera sem throttle)', async () => {
    const semKv = { ...baseEnv(), RATE_LIMIT: undefined } as unknown as Env;
    const res = await notify(
      { status: 'CREATION_SUCCESS', account_id: UA_NOVA, name: TOKEN_A },
      semKv,
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'rate_limit_unavailable' });
    expect(tokenRow('tok-A')?.status).toBe('pending');
  });
});
