import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

// Uma chave, varias contas (F2.42). O cliente escolhe a conta com o NOSSO
// account_id (acc_...) em qualquer chamada; o servidor so aceita contas do
// GRUPO da chave. Mesmo desenho dos outros testes: banco e origem mockados,
// a resolucao real (auth + lib/contas + lib/tenants) roda.
//
// Seed:
//   grupo do cliente A: tA (conta ativa), tA2 (ativa), tA3 (desconectada)
//   cliente B, sozinho: tB (ativa)

const KEY_A = 'lk_live_key_do_tenant_A';
const KEY_A3 = 'lk_live_key_do_tenant_A3';
const KEY_B = 'lk_live_key_do_tenant_B';

import { hashApiKey } from '../src/lib/tenants';

interface Linha {
  provider: string;
  tenant_id: string;
  unipile_account_id: string;
  status: string;
  label: string | null;
  created_at: string;
}

const TENANTS = [
  { id: 'tA', name: 'interno-A', group_id: 'tA', created_at: '2026-09-01T00:00:00Z' },
  { id: 'tA2', name: 'interno-A2', group_id: 'tA', created_at: '2026-09-02T00:00:00Z' },
  { id: 'tA3', name: 'interno-A3', group_id: 'tA', created_at: '2026-09-03T00:00:00Z' },
  { id: 'tB', name: 'interno-B', group_id: null, created_at: '2026-09-01T00:00:00Z' },
];

const CONTAS: Linha[] = [
  { provider: 'linkedin', tenant_id: 'tA', unipile_account_id: 'ua-A', status: 'active', label: 'Ana', created_at: '2026-09-01T10:00:00Z' },
  { provider: 'linkedin', tenant_id: 'tA2', unipile_account_id: 'ua-A2', status: 'active', label: 'Bruno', created_at: '2026-09-02T10:00:00Z' },
  { provider: 'linkedin', tenant_id: 'tA3', unipile_account_id: 'ua-A3', status: 'disconnected', label: 'Carla', created_at: '2026-09-03T10:00:00Z' },
  { provider: 'linkedin', tenant_id: 'tB', unipile_account_id: 'ua-B', status: 'active', label: 'Outro', created_at: '2026-09-01T10:00:00Z' },
];

function filtra<T extends Record<string, unknown>>(linhas: T[], filtros: Record<string, string>): T[] {
  return linhas.filter((l) =>
    Object.entries(filtros).every(([campo, f]) => {
      if (['select', 'order', 'limit'].includes(campo)) return true;
      const valor = String(l[campo]);
      if (f.startsWith('eq.')) return valor === f.slice(3);
      if (f.startsWith('in.(')) return f.slice(4, -1).split(',').includes(valor);
      return true;
    }),
  );
}

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(async (_env: Env, table: string, filters: Record<string, string>) => {
    if (table === 'api_keys') {
      const donos: Record<string, string> = {
        [await hashApiKey(KEY_A)]: 'tA',
        [await hashApiKey(KEY_A3)]: 'tA3',
        [await hashApiKey(KEY_B)]: 'tB',
      };
      const dono = donos[filters.key_hash?.slice(3) ?? ''];
      return dono ? [{ tenant_id: dono }] : [];
    }
    if (table === 'tenants') {
      // status=active: todos os do seed estao ativos.
      const { status: _s, ...resto } = filters;
      return filtra(TENANTS, resto);
    }
    if (table === 'connected_accounts') {
      const rows = filtra(CONTAS as unknown as Record<string, unknown>[], filters);
      return filters.limit === '1' ? rows.slice(0, 1) : rows;
    }
    return [];
  }),
  // Devolve a linha criada, como o PostgREST com return=representation (o
  // webhook novo do /v1/webhook le o id e a data dela, F2.43).
  supabaseInsert: vi.fn(async (_env: Env, _table: string, row: Record<string, unknown>) => [
    { id: 'novo', created_at: '2026-09-22T00:00:00Z', ...row },
  ]),
  supabaseUpdate: vi.fn(async () => null),
  supabaseRpc: vi.fn(async () => null),
}));

const ok = () =>
  new Response(JSON.stringify({ object: 'MessageSent', message_id: 'm1', items: [], cursor: null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

vi.mock('../src/lib/unipile', () => ({
  sendMessage: vi.fn(async () => ok()),
  sendInvitation: vi.fn(async () => ok()),
  listChats: vi.fn(async () => ok()),
}));

import app from '../src/index';
import { sendMessage, listChats } from '../src/lib/unipile';
import { supabaseInsert, supabaseUpdate } from '../src/lib/supabase';
import { accountIdPublico } from '../src/lib/contas';
import { memoryKV } from './helpers';

const env = {
  ENVIRONMENT: 'test',
  UNIPILE_DSN: 'apiX.unipile.com:0000',
  UNIPILE_MASTER_TOKEN: 'master-token-nunca-vaza',
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-nunca-vaza',
  RATE_LIMIT: memoryKV(),
} as Env;

const ID = {
  A: await accountIdPublico('tA'),
  A2: await accountIdPublico('tA2'),
  A3: await accountIdPublico('tA3'),
  B: await accountIdPublico('tB'),
};

function enviar(body: unknown, opts: { key?: string; query?: string } = {}) {
  return app.request(
    `/v1/messages${opts.query ?? ''}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-KEY': opts.key ?? KEY_A },
      body: JSON.stringify(body),
    },
    env,
  );
}

const contaDoUltimoEnvio = () => vi.mocked(sendMessage).mock.calls.at(-1)?.[3];

beforeEach(() => {
  vi.mocked(sendMessage).mockClear();
  vi.mocked(listChats).mockClear();
  vi.mocked(supabaseInsert).mockClear();
  vi.mocked(supabaseUpdate).mockClear();
});

describe('account_id: formato', () => {
  it('e nosso, estavel e nao carrega nada da origem', async () => {
    expect(ID.A).toMatch(/^acc_[0-9a-f]{24}$/);
    expect(await accountIdPublico('tA')).toBe(ID.A);
    expect(new Set(Object.values(ID)).size).toBe(4);
    expect(ID.A).not.toContain('ua-');
  });
});

describe('escolher a conta com account_id', () => {
  it('sem account_id: a conta da propria chave, como sempre', async () => {
    const res = await enviar({ chat_id: 'c1', text: 'oi' });
    expect(res.status).toBe(200);
    expect(contaDoUltimoEnvio()).toBe('ua-A');
  });

  it('account_id da propria conta: a mesma conta', async () => {
    const res = await enviar({ chat_id: 'c1', text: 'oi', account_id: ID.A });
    expect(res.status).toBe(200);
    expect(contaDoUltimoEnvio()).toBe('ua-A');
  });

  it('account_id de outra conta do grupo, no corpo JSON: age por ela', async () => {
    const res = await enviar({ chat_id: 'c1', text: 'oi', account_id: ID.A2 });
    expect(res.status).toBe(200);
    expect(contaDoUltimoEnvio()).toBe('ua-A2');
  });

  it('na query string: tambem vale (GET /v1/chats)', async () => {
    const res = await app.request(`/v1/chats?account_id=${ID.A2}`, { headers: { 'X-API-KEY': KEY_A } }, env);
    expect(res.status).toBe(200);
    expect(vi.mocked(listChats).mock.calls.at(-1)?.[1]).toBe('ua-A2');
  });

  it('no multipart: vale, e a rota ainda le o corpo inteiro', async () => {
    const form = new FormData();
    form.set('account_id', ID.A2);
    form.set('chat_id', 'c1');
    form.set('text', 'com anexo');
    form.append('attachments', new File(['conteudo'], 'a.txt', { type: 'text/plain' }));
    const res = await app.request('/v1/messages', { method: 'POST', headers: { 'X-API-KEY': KEY_A }, body: form }, env);
    expect(res.status).toBe(200);
    const chamada = vi.mocked(sendMessage).mock.calls.at(-1)!;
    expect(chamada[3]).toBe('ua-A2');
    expect(chamada[2]).toBe('com anexo');
    expect(chamada[4]).toHaveLength(1);
  });

  it('a cota do dia conta na conta escolhida, nao na da chave', async () => {
    const dia = new Date().toISOString().slice(0, 10);
    const antesA = Number((await env.RATE_LIMIT.get(`rl:tA:messages:${dia}`)) ?? '0');
    const antesA2 = Number((await env.RATE_LIMIT.get(`rl:tA2:messages:${dia}`)) ?? '0');
    await enviar({ chat_id: 'c1', text: 'oi', account_id: ID.A2 });
    expect(Number(await env.RATE_LIMIT.get(`rl:tA2:messages:${dia}`))).toBe(antesA2 + 1);
    expect(Number((await env.RATE_LIMIT.get(`rl:tA:messages:${dia}`)) ?? '0')).toBe(antesA);
  });

  it('funciona com a chave de qualquer conta do grupo, mesmo a desconectada', async () => {
    const res = await enviar({ chat_id: 'c1', text: 'oi', account_id: ID.A }, { key: KEY_A3 });
    expect(res.status).toBe(200);
    expect(contaDoUltimoEnvio()).toBe('ua-A');
  });

  it('conta do grupo com LinkedIn caido: 409 com o motivo, sem tocar a origem', async () => {
    const res = await enviar({ chat_id: 'c1', text: 'oi', account_id: ID.A3 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'account_disconnected' });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('account_id fora do grupo: 404 igual para tudo, sem oraculo', () => {
  const alheios: [string, () => string][] = [
    ['conta de outro cliente', () => ID.B],
    ['id da origem de outro cliente', () => 'ua-B'],
    ['id da origem da propria conta', () => 'ua-A'],
    ['acc_ inventado', () => 'acc_000000000000000000000000'],
    ['lixo', () => '../../admin'],
  ];
  for (const [nome, valor] of alheios) {
    it(nome, async () => {
      const res = await enviar({ chat_id: 'c1', text: 'oi', account_id: valor() });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'account_not_found' });
      expect(sendMessage).not.toHaveBeenCalled();
    });
  }

  it('a chave de B nao alcanca o grupo de A', async () => {
    const res = await enviar({ chat_id: 'c1', text: 'oi', account_id: ID.A }, { key: KEY_B });
    expect(res.status).toBe(404);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('chave invalida continua 401 antes de qualquer coisa', async () => {
    const res = await enviar({ chat_id: 'c1', text: 'oi', account_id: ID.A2 }, { key: 'lk_live_nao_existe' });
    expect(res.status).toBe(401);
  });
});

describe('account_id mal enviado: 400', () => {
  it('query e corpo divergentes', async () => {
    const res = await enviar({ chat_id: 'c1', text: 'oi', account_id: ID.A }, { query: `?account_id=${ID.A2}` });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'account_id_conflict' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('query e corpo iguais: tudo bem', async () => {
    const res = await enviar({ chat_id: 'c1', text: 'oi', account_id: ID.A2 }, { query: `?account_id=${ID.A2}` });
    expect(res.status).toBe(200);
    expect(contaDoUltimoEnvio()).toBe('ua-A2');
  });

  it('tipo que nao e texto', async () => {
    const res = await enviar({ chat_id: 'c1', text: 'oi', account_id: ['x'] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_account_id' });
  });

  it('JSON quebrado segue caindo no invalid_json da rota', async () => {
    const res = await app.request(
      '/v1/messages',
      { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-KEY': KEY_A }, body: '{nao e json' },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
  });
});

describe('corpo grande: 413 antes de ler tudo, sem tocar a origem', () => {
  it('JSON acima de 1 MB, sem content-length (le em stream e para no teto)', async () => {
    const enorme = JSON.stringify({ chat_id: 'c1', text: 'x'.repeat(1024 * 1024 + 10), account_id: ID.A2 });
    const res = await app.request(
      '/v1/messages',
      { method: 'POST', headers: { 'content-type': 'application/json', 'X-API-KEY': KEY_A }, body: enorme },
      env,
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'body_too_large' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('content-length declarado acima do teto: recusa sem ler', async () => {
    const res = await app.request(
      '/v1/messages',
      {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=x',
          'content-length': String(200 * 1024 * 1024),
          'X-API-KEY': KEY_A,
        },
        body: '--x--',
      },
      env,
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: 'attachments_too_large' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a rota ainda le o corpo que o middleware leu (JSON via cache)', async () => {
    const res = await app.request(
      '/v1/webhook',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'X-API-KEY': KEY_A },
        body: JSON.stringify({ url: 'https://meuapp.com.br/hooks' }),
      },
      env,
    );
    expect(res.status).toBe(200);
  });
});

describe('conta escolhida no contexto', () => {
  it('accountIdEscolhido so vem preenchido quando a request escolheu outra conta', async () => {
    const { authMiddleware } = await import('../src/middleware/auth');
    const { Hono } = await import('hono');
    const probe = new Hono<{ Bindings: Env; Variables: import('../src/types').Variables }>();
    probe.use('*', authMiddleware);
    probe.get('/x', (c) => c.json({ escolhido: c.get('tenant').accountIdEscolhido }));
    const pedir = async (q: string) =>
      (await (await probe.request(`/x${q}`, { headers: { 'X-API-KEY': KEY_A } }, env)).json()) as {
        escolhido: string | null;
      };
    expect((await pedir('')).escolhido).toBeNull();
    expect((await pedir(`?account_id=${ID.A}`)).escolhido).toBeNull();
    expect((await pedir(`?account_id=${ID.A2}`)).escolhido).toBe(ID.A2);
  });
});

describe('GET /v1/accounts', () => {
  it('lista as contas do grupo com o account_id de cada uma, e nada da origem', async () => {
    const res = await app.request('/v1/accounts', { headers: { 'X-API-KEY': KEY_A } }, env);
    expect(res.status).toBe(200);
    const texto = await res.text();
    for (const proibido of ['ua-', 'interno-', 'tA', 'unipile']) expect(texto).not.toContain(proibido);
    expect(JSON.parse(texto)).toEqual({
      ok: true,
      data: {
        items: [
          { account_id: ID.A, name: 'Ana', status: 'active', connected_at: '2026-09-01T10:00:00Z', is_key_account: true },
          { account_id: ID.A2, name: 'Bruno', status: 'active', connected_at: '2026-09-02T10:00:00Z', is_key_account: false },
          { account_id: ID.A3, name: 'Carla', status: 'disconnected', connected_at: '2026-09-03T10:00:00Z', is_key_account: false },
        ],
      },
    });
  });

  it('responde mesmo com a conta da chave desconectada', async () => {
    const res = await app.request('/v1/accounts', { headers: { 'X-API-KEY': KEY_A3 } }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: { account_id: string; is_key_account: boolean }[] } };
    expect(body.data.items.find((i) => i.is_key_account)?.account_id).toBe(ID.A3);
  });

  it('cliente sem grupo ve so a propria conta', async () => {
    const res = await app.request('/v1/accounts', { headers: { 'X-API-KEY': KEY_B } }, env);
    const body = (await res.json()) as { data: { items: { account_id: string }[] } };
    expect(body.data.items.map((i) => i.account_id)).toEqual([ID.B]);
  });

  it('sem chave: 401', async () => {
    expect((await app.request('/v1/accounts', {}, env)).status).toBe(401);
    expect((await app.request('/v1/accounts', { headers: { 'X-API-KEY': 'x' } }, env)).status).toBe(401);
  });
});

describe('rotas da conta com account_id', () => {
  it('webhook: configura o da conta escolhida', async () => {
    const res = await app.request(
      '/v1/webhook',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'X-API-KEY': KEY_A },
        body: JSON.stringify({ url: 'https://meuapp.com.br/hooks', account_id: ID.A2 }),
      },
      env,
    );
    expect(res.status).toBe(200);
    // F2.43: o webhook mora em client_webhooks; sem nenhum ainda, nasce o
    // principal da conta escolhida.
    const criado = vi.mocked(supabaseInsert).mock.calls.at(-1)!;
    expect(criado[1]).toBe('client_webhooks');
    expect(criado[2]).toMatchObject({ tenant_id: 'tA2', url: 'https://meuapp.com.br/hooks' });
  });

  it('rotacao de chave: sempre a chave usada, nunca a conta escolhida', async () => {
    const res = await app.request(
      `/v1/keys/rotate?account_id=${ID.A2}`,
      { method: 'POST', headers: { 'X-API-KEY': KEY_A } },
      env,
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(supabaseInsert).mock.calls.at(-1)?.[2]).toMatchObject({ tenant_id: 'tA' });
    expect(vi.mocked(supabaseUpdate).mock.calls.at(-1)?.[2]).toEqual({
      key_hash: `eq.${await hashApiKey(KEY_A)}`,
      tenant_id: 'eq.tA',
    });
  });
});

describe('documentacao do account_id', () => {
  interface Op {
    parameters?: { $ref?: string; name?: string }[];
    requestBody?: { content: Record<string, { schema: unknown }> };
  }
  async function spec() {
    const res = await app.request('/openapi.json', {}, env);
    return (await res.json()) as {
      info: { description: string };
      paths: Record<string, Record<string, Op>>;
      components: { schemas: Record<string, unknown>; parameters: Record<string, unknown> };
    };
  }

  function resolve(s: Awaited<ReturnType<typeof spec>>, v: unknown): Record<string, unknown> {
    const o = v as { $ref?: string };
    if (o?.$ref) return s.components.schemas[o.$ref.split('/').pop()!] as Record<string, unknown>;
    return v as Record<string, unknown>;
  }

  it('toda operacao do /v1 aceita account_id (corpo ou query), salvo rotacao e a lista', async () => {
    const s = await spec();
    const semCampo: string[] = [];
    for (const [caminho, item] of Object.entries(s.paths)) {
      if (!caminho.startsWith('/v1/') || caminho === '/v1/keys/rotate' || caminho === '/v1/accounts') continue;
      for (const [metodo, op] of Object.entries(item)) {
        const naQuery = (op.parameters ?? []).some(
          (p) => p.$ref === '#/components/parameters/AccountId' || p.name === 'account_id',
        );
        const noCorpo = Object.values(op.requestBody?.content ?? {}).some((m) => {
          const schema = resolve(s, m.schema);
          const props = schema.properties as Record<string, unknown> | undefined;
          return Boolean(props?.account_id) || JSON.stringify(schema).includes('"account_id"');
        });
        if (!naQuery && !noCorpo) semCampo.push(`${metodo.toUpperCase()} ${caminho}`);
      }
    }
    expect(semCampo).toEqual([]);
  });

  it('documenta GET /v1/accounts e a secao da introducao', async () => {
    const s = await spec();
    expect(s.paths['/v1/accounts']?.get).toBeTruthy();
    expect(s.info.description).toContain('## Varias contas com uma chave');
    expect(s.info.description).toContain('`account_not_found`');
    expect(s.info.description).not.toContain('nao precisa (nem pode)');
  });
});
