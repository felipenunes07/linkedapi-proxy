import type { Env } from '../types';
import { supabaseSelect, supabaseDelete } from './supabase';
import {
  cancelCardCheckout,
  cardCheckoutStatus,
  cancelPixAutomaticAuthorization,
  pixAutomaticAuthorizationStatus,
} from './asaas';

// Faxina de checkouts abandonados (review F2.25, I1). Roda de hora em hora pelo
// cron do Worker (wrangler.jsonc, "triggers").
//
// Alvo: tenant que nasceu no checkout (cartao ou Pix Automatico) e NUNCA pagou
// em 24h. Nesse ponto a sessao de cartao (60 min) e o QR do Pix (1h) ja
// venceram. Sem faxina, o tenant fica "Aguardando" para sempre, aparece no
// "entrar no painel" e confunde a operacao.
//
// Regra do PRD: so se apaga o que NUNCA valeu. Por isso, antes de apagar:
//   - sem conta LinkedIn e sem chave de API (senao e cliente de verdade);
//   - o objeto no Asaas precisa estar comprovadamente morto (cancelado ou
//     vencido) ou ser cancelado agora. Pago, ativo sem cancelamento, ou sem
//     como conferir: NAO mexe (pode ser webhook atrasado) e so sinaliza.
// Apagar o tenant leva junto, em cascata, o vinculo de cobranca e as
// credenciais do painel.

const IDADE_MINIMA_MS = 24 * 60 * 60 * 1000;
const LOTE = 50;
const MORTOS_CARTAO = new Set(['CANCELED', 'EXPIRED']);
const MORTOS_PIX = new Set(['CANCELLED', 'CANCELED', 'EXPIRED', 'REFUSED', 'DENIED']);

interface PendenteRow {
  tenant_id: string;
  payment_method: string | null;
  asaas_checkout_id: string | null;
  asaas_authorization_id: string | null;
}

async function objetoAsaasMorto(env: Env, p: PendenteRow): Promise<boolean> {
  if (p.payment_method === 'card' && p.asaas_checkout_id) {
    const status = await cardCheckoutStatus(env, p.asaas_checkout_id).catch(() => null);
    if (status && MORTOS_CARTAO.has(status)) return true;
    if (status === 'ACTIVE') {
      return cancelCardCheckout(env, p.asaas_checkout_id).catch(() => false);
    }
    return false;
  }
  if (p.payment_method === 'pix_automatic' && p.asaas_authorization_id) {
    const status = await pixAutomaticAuthorizationStatus(env, p.asaas_authorization_id).catch(
      () => null,
    );
    if (status && MORTOS_PIX.has(status)) return true;
    if (status === 'ACTIVE') return false; // autorizou: nao e abandono
    return cancelPixAutomaticAuthorization(env, p.asaas_authorization_id).catch(() => false);
  }
  return false;
}

export async function limparCheckoutsAbandonados(
  env: Env,
): Promise<{ removidos: number; mantidos: number }> {
  if (!env.ASAAS_API_KEY) {
    return { removidos: 0, mantidos: 0 };
  }
  const limite = new Date(Date.now() - IDADE_MINIMA_MS).toISOString();
  const pendentes = await supabaseSelect<PendenteRow>(env, 'billing_subscriptions', {
    status: 'eq.pending',
    payment_method: 'in.(card,pix_automatic)',
    created_at: `lt.${limite}`,
    select: 'tenant_id,payment_method,asaas_checkout_id,asaas_authorization_id',
    limit: String(LOTE),
  });

  let removidos = 0;
  let mantidos = 0;
  for (const p of pendentes) {
    const [contas, chaves] = await Promise.all([
      supabaseSelect<{ id: string }>(env, 'connected_accounts', {
        tenant_id: `eq.${p.tenant_id}`,
        select: 'id',
        limit: '1',
      }),
      supabaseSelect<{ id: string }>(env, 'api_keys', {
        tenant_id: `eq.${p.tenant_id}`,
        select: 'id',
        limit: '1',
      }),
    ]);
    if (contas[0] || chaves[0] || !(await objetoAsaasMorto(env, p))) {
      mantidos += 1;
      // So o uuid do tenant (nosso), nunca dado de cobranca ou pessoal.
      console.error(`limpeza_mantido: ${p.tenant_id}`);
      continue;
    }
    await supabaseDelete(env, 'tenants', { id: `eq.${p.tenant_id}` });
    removidos += 1;
  }
  if (removidos || mantidos) {
    console.log(`limpeza_checkouts removidos=${removidos} mantidos=${mantidos}`);
  }
  return { removidos, mantidos };
}
