import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

// F2.40: conta apagada na origem. Nao chega webhook: o banco continua dizendo
// "ativa", o painel mostra tudo verde e a chave do cliente falha calada. O que
// estes testes seguram e o lado perigoso da correcao: na duvida sobre a lista
// da origem, NAO marcar nada. Marcar demais derruba cliente pagante.

let nossas: Array<Record<string, unknown>> = [];
let atualizacoes: Array<{ filtros: Record<string, string>; campos: Record<string, unknown> }> = [];
let resposta: { ok: boolean; status: number; corpo: unknown } = {
  ok: true,
  status: 200,
  corpo: { items: [] },
};

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(async () => nossas),
  supabaseUpdate: vi.fn(
    async (
      _env: Env,
      _tabela: string,
      filtros: Record<string, string>,
      campos: Record<string, unknown>,
    ) => {
      atualizacoes.push({ filtros, campos });
      return [{ id: 'linha' }];
    },
  ),
  supabaseDelete: vi.fn(async () => undefined),
}));

vi.mock('../src/lib/unipile', () => ({
  listAccounts: vi.fn(async () => {
    if (resposta.status === 0) throw new Error('rede');
    return {
      ok: resposta.ok,
      status: resposta.status,
      json: async () => resposta.corpo,
    } as unknown as Response;
  }),
}));

vi.mock('../src/lib/asaas', () => ({
  cancelCardCheckout: vi.fn(),
  listPayments: vi.fn(),
  pixAutomaticAuthorizationStatus: vi.fn(),
  cancelPixAutomaticAuthorization: vi.fn(),
}));

import { conciliarContasSumidas } from '../src/lib/limpeza';

const env = {} as Env;

function conta(id: string, tenant: string) {
  return { id: `row_${id}`, tenant_id: tenant, unipile_account_id: id };
}

describe('conciliacao de contas sumidas na origem (F2.40)', () => {
  beforeEach(() => {
    nossas = [conta('viva', 'tA'), conta('sumida', 'tB')];
    atualizacoes = [];
    resposta = { ok: true, status: 200, corpo: { items: [{ id: 'viva' }], cursor: null } };
  });

  it('marca como desconectada so a conta que a origem nao reconhece', async () => {
    expect(await conciliarContasSumidas(env)).toBe(1);
    expect(atualizacoes).toHaveLength(1);
    expect(atualizacoes[0]!.filtros).toMatchObject({ id: 'eq.row_sumida', status: 'eq.active' });
    expect(atualizacoes[0]!.campos).toEqual({ status: 'disconnected' });
  });

  it('origem fora do ar: NAO marca nada', async () => {
    resposta = { ok: false, status: 503, corpo: {} };
    expect(await conciliarContasSumidas(env)).toBe(0);
    expect(atualizacoes).toHaveLength(0);
  });

  it('erro de rede: NAO marca nada', async () => {
    resposta = { ok: true, status: 0, corpo: {} };
    expect(await conciliarContasSumidas(env)).toBe(0);
    expect(atualizacoes).toHaveLength(0);
  });

  it('lista vazia e resposta quebrada dao no mesmo: NAO marca nada', async () => {
    resposta = { ok: true, status: 200, corpo: { items: [] } };
    expect(await conciliarContasSumidas(env)).toBe(0);
    expect(atualizacoes).toHaveLength(0);
  });

  it('lista paginada: NAO marca nada, porque a conta pode estar na proxima pagina', async () => {
    resposta = { ok: true, status: 200, corpo: { items: [{ id: 'viva' }], cursor: 'proxima' } };
    expect(await conciliarContasSumidas(env)).toBe(0);
    expect(atualizacoes).toHaveLength(0);
  });

  it('todas reconhecidas: nao toca em nada', async () => {
    resposta = {
      ok: true,
      status: 200,
      corpo: { items: [{ id: 'viva' }, { id: 'sumida' }], cursor: null },
    };
    expect(await conciliarContasSumidas(env)).toBe(0);
    expect(atualizacoes).toHaveLength(0);
  });
});
