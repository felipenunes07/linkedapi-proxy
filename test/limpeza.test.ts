import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

// Faxina de checkouts abandonados (review F2.25, 2a rodada). So apaga o que
// nunca valeu: vinculo parado ha mais de 24h, sem assinatura, sem conta, sem
// chave, com o objeto do Asaas morto e sem cobranca com dinheiro. Na duvida,
// mantem (e o item vai para o fim da fila).

let pendentes: Array<Record<string, unknown>> = [];
let comConta = new Set<string>();
let comChave = new Set<string>();
let falhaNaConta = new Set<string>();
let refeitos = new Set<string>();
let filtroPendentes: Record<string, string> | null = null;

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(async (_env: Env, table: string, filters: Record<string, string>) => {
    const tenant = String(filters.tenant_id ?? '').replace(/^eq\./, '');
    if (table === 'billing_subscriptions') {
      // Reconferencia na hora de apagar (filtra pelo tenant).
      if (filters.tenant_id) return refeitos.has(tenant) ? [] : [{ tenant_id: tenant }];
      filtroPendentes = filters;
      return pendentes;
    }
    if (table === 'connected_accounts') {
      if (falhaNaConta.has(tenant)) throw new Error('supabase_select_failed:503');
      return comConta.has(tenant) ? [{ id: 'ca' }] : [];
    }
    if (table === 'api_keys') return comChave.has(tenant) ? [{ id: 'k' }] : [];
    return [];
  }),
  supabaseDelete: vi.fn(async () => undefined),
  supabaseUpdate: vi.fn(async () => []),
}));

vi.mock('../src/lib/asaas', () => ({
  // Sessao de cartao com 24h ja venceu: o cancelamento e recusado (4xx).
  cancelCardCheckout: vi.fn(async () => 'recusado'),
  listPayments: vi.fn(async () => []),
  pixAutomaticAuthorizationStatus: vi.fn(async () => 'EXPIRED'),
  cancelPixAutomaticAuthorization: vi.fn(async () => true),
}));

import { limparCheckoutsAbandonados } from '../src/lib/limpeza';
import { supabaseDelete, supabaseUpdate } from '../src/lib/supabase';
import {
  cancelCardCheckout,
  cancelPixAutomaticAuthorization,
  listPayments,
  pixAutomaticAuthorizationStatus,
} from '../src/lib/asaas';

const env = { ASAAS_API_KEY: 'k' } as Env;

function cartao(tenant: string) {
  return {
    tenant_id: tenant,
    payment_method: 'card',
    asaas_customer_id: null,
    asaas_checkout_id: `chk_${tenant}`,
    asaas_authorization_id: null,
  };
}
function pix(tenant: string) {
  return {
    tenant_id: tenant,
    payment_method: 'pix_automatic',
    asaas_customer_id: `cus_${tenant}`,
    asaas_checkout_id: null,
    asaas_authorization_id: `auth_${tenant}`,
  };
}
function cobranca(status: string, checkoutSession: string | null = null) {
  return { id: 'pay', status, subscription: null, customer: null, checkoutSession, dueDate: null };
}
const apagados = () =>
  vi.mocked(supabaseDelete).mock.calls.map((c) => (c[2] as { id: string }).id);

beforeEach(() => {
  vi.clearAllMocks();
  pendentes = [];
  comConta = new Set();
  comChave = new Set();
  falhaNaConta = new Set();
  refeitos = new Set();
  filtroPendentes = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('faxina de checkouts abandonados', () => {
  it('so busca vinculos sem assinatura, parados ha 24h, num lote que cabe no Workers Free', async () => {
    await limparCheckoutsAbandonados(env);
    expect(filtroPendentes).toMatchObject({
      // overdue: QR do Pix que venceu sem pagamento (F2.27).
      status: 'in.(pending,canceled,overdue)',
      payment_method: 'in.(card,pix_automatic)',
      // BLOQUEANTE #7: vinculo refeito pelo operador (com assinatura) nunca entra.
      asaas_subscription_id: 'is.null',
      order: 'updated_at.asc',
      limit: '6',
    });
    const desde = Date.parse(String(filtroPendentes!.updated_at).replace(/^lt\./, ''));
    expect(Date.now() - desde).toBeGreaterThan(23.9 * 60 * 60 * 1000);
  });

  it('sessao de cartao sem cobranca e Pix vencido sem pagamento: apaga os tenants', async () => {
    pendentes = [cartao('t1'), pix('t2')];
    const r = await limparCheckoutsAbandonados(env);
    expect(r).toEqual({ removidos: 2, mantidos: 0 });
    expect(apagados()).toEqual(['eq.t1', 'eq.t2']);
    expect(listPayments).toHaveBeenCalledWith(env, { checkoutSession: 'chk_t1' }, 1);
    expect(listPayments).toHaveBeenCalledWith(env, { customer: 'cus_t2' }, 10);
  });

  it('BLOQUEANTE #6: Pix sem resposta, autorizado ou com status estranho NAO e cancelado nem apagado', async () => {
    pendentes = [pix('semResposta'), pix('autorizado'), pix('estranho')];
    vi.mocked(pixAutomaticAuthorizationStatus)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('ACTIVE')
      .mockResolvedValueOnce('DENIED');
    const r = await limparCheckoutsAbandonados(env);
    expect(r).toEqual({ removidos: 0, mantidos: 3 });
    expect(cancelPixAutomaticAuthorization).not.toHaveBeenCalled();
    expect(supabaseDelete).not.toHaveBeenCalled();
  });

  it('Pix ainda nao autorizado (CREATED) e sem pagamento: cancela e so entao apaga', async () => {
    pendentes = [pix('t3'), pix('t4')];
    vi.mocked(pixAutomaticAuthorizationStatus)
      .mockResolvedValueOnce('CREATED')
      .mockResolvedValueOnce('CREATED');
    vi.mocked(cancelPixAutomaticAuthorization)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const r = await limparCheckoutsAbandonados(env);
    expect(cancelPixAutomaticAuthorization).toHaveBeenCalledWith(env, 'auth_t3');
    expect(r).toEqual({ removidos: 1, mantidos: 1 });
    expect(apagados()).toEqual(['eq.t3']);
  });

  it('#8: qualquer sinal de dinheiro, ou consulta que falhou, mantem o tenant', async () => {
    pendentes = [cartao('cartaoComCobranca'), pix('pixPago'), cartao('consultaFalhou')];
    vi.mocked(listPayments)
      .mockResolvedValueOnce([cobranca('PENDING', 'chk_cartaoComCobranca')])
      .mockResolvedValueOnce([cobranca('PENDING'), cobranca('RECEIVED')])
      .mockResolvedValueOnce(null);
    const r = await limparCheckoutsAbandonados(env);
    expect(r).toEqual({ removidos: 0, mantidos: 3 });
    expect(supabaseDelete).not.toHaveBeenCalled();
  });

  it('tenant com conta conectada ou chave de API nunca e apagado, e o Asaas nem e tocado', async () => {
    pendentes = [cartao('comConta'), pix('comChave')];
    comConta.add('comConta');
    comChave.add('comChave');
    const r = await limparCheckoutsAbandonados(env);
    expect(r).toEqual({ removidos: 0, mantidos: 2 });
    expect(cancelCardCheckout).not.toHaveBeenCalled();
    expect(pixAutomaticAuthorizationStatus).not.toHaveBeenCalled();
    expect(supabaseDelete).not.toHaveBeenCalled();
  });

  it('#10: erro num item nao para os outros; o mantido vai para o fim da fila', async () => {
    pendentes = [cartao('quebrado'), cartao('ok')];
    falhaNaConta.add('quebrado');
    const r = await limparCheckoutsAbandonados(env);
    expect(r).toEqual({ removidos: 1, mantidos: 1 });
    expect(apagados()).toEqual(['eq.ok']);
    const bump = vi.mocked(supabaseUpdate).mock.calls[0]!;
    expect(bump[1]).toBe('billing_subscriptions');
    expect(bump[2]).toEqual({ tenant_id: 'eq.quebrado', asaas_subscription_id: 'is.null' });
    expect(bump[3]).toHaveProperty('updated_at');
  });

  it('F2.27: cancelamento da sessao sem resposta do Asaas: mantem (a sessao pode estar viva)', async () => {
    pendentes = [cartao('semResposta')];
    vi.mocked(cancelCardCheckout).mockResolvedValueOnce('falhou');
    const r = await limparCheckoutsAbandonados(env);
    expect(r).toEqual({ removidos: 0, mantidos: 1 });
    expect(listPayments).not.toHaveBeenCalled();
    expect(supabaseDelete).not.toHaveBeenCalled();
  });

  it('F2.27: vinculo refeito pelo operador durante as checagens: nao apaga', async () => {
    pendentes = [cartao('refeito')];
    refeitos.add('refeito');
    const r = await limparCheckoutsAbandonados(env);
    expect(r).toEqual({ removidos: 0, mantidos: 1 });
    expect(supabaseDelete).not.toHaveBeenCalled();
  });

  it('sem ASAAS_API_KEY nao faz nada', async () => {
    pendentes = [cartao('t9')];
    const r = await limparCheckoutsAbandonados({} as Env);
    expect(r).toEqual({ removidos: 0, mantidos: 0 });
    expect(supabaseDelete).not.toHaveBeenCalled();
  });
});
