import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../src/types';

// Faxina de checkouts abandonados (review F2.25, I1). So apaga o que nunca
// valeu: pendente ha mais de 24h, sem conta, sem chave, e com o objeto do Asaas
// comprovadamente morto (ou cancelado agora). Na duvida, mantem.

let pendentes: Array<Record<string, unknown>> = [];
let comConta = new Set<string>();
let comChave = new Set<string>();
let filtroPendentes: Record<string, string> | null = null;

vi.mock('../src/lib/supabase', () => ({
  supabaseSelect: vi.fn(async (_env: Env, table: string, filters: Record<string, string>) => {
    const tenant = String(filters.tenant_id ?? '').replace(/^eq\./, '');
    if (table === 'billing_subscriptions') {
      filtroPendentes = filters;
      return pendentes;
    }
    if (table === 'connected_accounts') return comConta.has(tenant) ? [{ id: 'ca' }] : [];
    if (table === 'api_keys') return comChave.has(tenant) ? [{ id: 'k' }] : [];
    return [];
  }),
  supabaseDelete: vi.fn(async () => undefined),
}));

vi.mock('../src/lib/asaas', () => ({
  cardCheckoutStatus: vi.fn(async () => 'EXPIRED'),
  cancelCardCheckout: vi.fn(async () => true),
  pixAutomaticAuthorizationStatus: vi.fn(async () => 'EXPIRED'),
  cancelPixAutomaticAuthorization: vi.fn(async () => true),
}));

import { limparCheckoutsAbandonados } from '../src/lib/limpeza';
import { supabaseDelete } from '../src/lib/supabase';
import {
  cardCheckoutStatus,
  cancelCardCheckout,
  pixAutomaticAuthorizationStatus,
} from '../src/lib/asaas';

const env = { ASAAS_API_KEY: 'k' } as Env;

function cartao(tenant: string, checkout = `chk_${tenant}`) {
  return { tenant_id: tenant, payment_method: 'card', asaas_checkout_id: checkout, asaas_authorization_id: null };
}
function pix(tenant: string) {
  return { tenant_id: tenant, payment_method: 'pix_automatic', asaas_checkout_id: null, asaas_authorization_id: `auth_${tenant}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  pendentes = [];
  comConta = new Set();
  comChave = new Set();
  filtroPendentes = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('faxina de checkouts abandonados', () => {
  it('so busca pendentes de cartao/Pix Automatico com mais de 24h', async () => {
    await limparCheckoutsAbandonados(env);
    expect(filtroPendentes).toMatchObject({
      status: 'eq.pending',
      payment_method: 'in.(card,pix_automatic)',
    });
    const desde = Date.parse(String(filtroPendentes!.created_at).replace(/^lt\./, ''));
    expect(Date.now() - desde).toBeGreaterThan(23.9 * 60 * 60 * 1000);
  });

  it('sessao de cartao vencida e Pix vencido, sem conta nem chave: apaga os tenants', async () => {
    pendentes = [cartao('t1'), pix('t2')];
    const r = await limparCheckoutsAbandonados(env);
    expect(r).toEqual({ removidos: 2, mantidos: 0 });
    expect(supabaseDelete).toHaveBeenCalledWith(env, 'tenants', { id: 'eq.t1' });
    expect(supabaseDelete).toHaveBeenCalledWith(env, 'tenants', { id: 'eq.t2' });
  });

  it('sessao ainda ATIVA: cancela no Asaas e so entao apaga', async () => {
    pendentes = [cartao('t3')];
    vi.mocked(cardCheckoutStatus).mockResolvedValueOnce('ACTIVE');
    const r = await limparCheckoutsAbandonados(env);
    expect(cancelCardCheckout).toHaveBeenCalledWith(env, 'chk_t3');
    expect(r.removidos).toBe(1);
  });

  it('na duvida mantem: sessao PAGA, status indefinido, cancelamento falhou, Pix autorizado', async () => {
    pendentes = [cartao('pago'), cartao('indef'), cartao('falhou'), pix('autorizado')];
    vi.mocked(cardCheckoutStatus)
      .mockResolvedValueOnce('PAID')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('ACTIVE');
    vi.mocked(cancelCardCheckout).mockResolvedValueOnce(false);
    vi.mocked(pixAutomaticAuthorizationStatus).mockResolvedValueOnce('ACTIVE');
    const r = await limparCheckoutsAbandonados(env);
    expect(r).toEqual({ removidos: 0, mantidos: 4 });
    expect(supabaseDelete).not.toHaveBeenCalled();
  });

  it('tenant com conta conectada ou chave de API nunca e apagado', async () => {
    pendentes = [cartao('comConta'), pix('comChave')];
    comConta.add('comConta');
    comChave.add('comChave');
    const r = await limparCheckoutsAbandonados(env);
    expect(r).toEqual({ removidos: 0, mantidos: 2 });
    expect(supabaseDelete).not.toHaveBeenCalled();
  });

  it('sem ASAAS_API_KEY nao faz nada', async () => {
    pendentes = [cartao('t9')];
    const r = await limparCheckoutsAbandonados({} as Env);
    expect(r).toEqual({ removidos: 0, mantidos: 0 });
    expect(supabaseDelete).not.toHaveBeenCalled();
  });
});
