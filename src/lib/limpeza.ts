import type { Env } from '../types';
import { supabaseSelect, supabaseDelete, supabaseUpdate } from './supabase';
import {
  cancelCardCheckout,
  cancelPixAutomaticAuthorization,
  listPayments,
  pixAutomaticAuthorizationStatus,
} from './asaas';

// Faxina de checkouts abandonados (review F2.25, I1; refeita na 2a rodada do
// review). Roda de hora em hora pelo cron do Worker (wrangler.jsonc).
//
// Alvo: tenant que nasceu no checkout (cartao ou Pix Automatico) e NUNCA pagou:
// vinculo `pending`, `canceled` (o proprio cliente recomecou o checkout ou
// trocou de metodo) ou `overdue` (o QR imediato do Pix venceu sem pagamento e
// o webhook marcou o atraso), sempre SEM assinatura e parado ha mais de 24h.
// Nesse ponto a sessao de cartao (60 min) e o QR do Pix (1h) ja venceram.
//
// Regra do PRD: so se apaga o que NUNCA valeu. Antes de apagar:
//   - sem conta LinkedIn e sem chave de API;
//   - objeto do Asaas morto E sem nenhuma cobranca com dinheiro
//     (encerrarCheckout).
// Na duvida (Asaas sem resposta, status desconhecido), mantem e so sinaliza.
// Apagar o tenant leva junto, em cascata, o vinculo e as credenciais do painel.

const IDADE_MINIMA_MS = 24 * 60 * 60 * 1000;
// Workers Free: 50 subrequests por invocacao. Cada pendente custa ate 7 (3
// selects, ate 3 chamadas ao Asaas, 1 escrita) e a busca 1: 6 cabem com folga.
const LOTE = 6;
const STATUS_FAXINA = 'in.(pending,canceled,overdue)';
// Autorizacao de Pix Automatico que nunca vai debitar.
const PIX_MORTO = new Set(['CANCELLED', 'EXPIRED', 'REFUSED']);
// Cobranca sem dinheiro. Qualquer outro status (paga, estornada, em analise)
// prova que o checkout valeu.
const SEM_DINHEIRO = new Set(['PENDING', 'OVERDUE']);

export interface PendenteRow {
  tenant_id: string;
  payment_method: string | null;
  asaas_customer_id: string | null;
  asaas_checkout_id: string | null;
  asaas_authorization_id: string | null;
}

const SELECT_PENDENTE =
  'tenant_id,payment_method,asaas_customer_id,asaas_checkout_id,asaas_authorization_id';

// Vinculo pendente dono de uma sessao de cartao ou de uma autorizacao Pix (o
// lock do checkout guarda so esse id).
export async function pendentePorAncora(
  env: Env,
  ancora: { metodo: 'card' | 'pix_automatic'; id: string },
): Promise<PendenteRow | null> {
  const coluna = ancora.metodo === 'card' ? 'asaas_checkout_id' : 'asaas_authorization_id';
  const rows = await supabaseSelect<PendenteRow>(env, 'billing_subscriptions', {
    [coluna]: `eq.${ancora.id}`,
    payment_method: `eq.${ancora.metodo}`,
    status: 'eq.pending',
    asaas_subscription_id: 'is.null',
    select: SELECT_PENDENTE,
    limit: '1',
  });
  return rows[0] ?? null;
}

// Garante que o objeto do Asaas de um checkout pendente nao cobra mais nada e
// nunca recebeu dinheiro. true = pode descartar. Qualquer duvida = false.
export async function encerrarCheckout(env: Env, p: PendenteRow): Promise<boolean> {
  if (p.payment_method === 'card' && p.asaas_checkout_id) {
    // Nao existe GET da sessao de checkout (404 no real em 2026-09-10).
    // Cancelar primeiro: sessao viva morre aqui ('ok'); vencida, cancelada ou
    // paga recusa com 4xx ('recusado'). Sem resposta, 5xx ou 429 ('falhou') a
    // sessao pode seguir viva e pagavel: nao sei = nao encerra (review F2.27;
    // senao nasciam duas assinaturas no mesmo cartao). Depois, a prova: nenhuma
    // cobranca nasceu dela. No cartao ate cobranca pendente conta, porque ela
    // so existe se o pagador enviou o cartao.
    if ((await cancelCardCheckout(env, p.asaas_checkout_id)) === 'falhou') return false;
    const cobrancas = await listPayments(env, { checkoutSession: p.asaas_checkout_id }, 1).catch(
      () => null,
    );
    return cobrancas !== null && cobrancas.length === 0;
  }
  if (p.payment_method === 'pix_automatic' && p.asaas_authorization_id && p.asaas_customer_id) {
    const status = await pixAutomaticAuthorizationStatus(env, p.asaas_authorization_id).catch(
      () => null,
    );
    // So segue com CREATED (QR ainda nao autorizado) ou autorizacao morta.
    // ACTIVE = o pagador autorizou (cliente de verdade); null ou status
    // desconhecido = nao sei. Em nenhum desses se cancela nada.
    if (status !== 'CREATED' && !(status && PIX_MORTO.has(status))) return false;
    const cobrancas = await listPayments(env, { customer: p.asaas_customer_id }, 10).catch(
      () => null,
    );
    if (cobrancas === null || cobrancas.some((x) => !SEM_DINHEIRO.has(x.status))) return false;
    if (status === 'CREATED') {
      return cancelPixAutomaticAuthorization(env, p.asaas_authorization_id).catch(() => false);
    }
    return true;
  }
  return false;
}

async function nuncaValeu(env: Env, tenantId: string): Promise<boolean> {
  const [contas, chaves] = await Promise.all([
    supabaseSelect<{ id: string }>(env, 'connected_accounts', {
      tenant_id: `eq.${tenantId}`,
      select: 'id',
      limit: '1',
    }),
    supabaseSelect<{ id: string }>(env, 'api_keys', {
      tenant_id: `eq.${tenantId}`,
      select: 'id',
      limit: '1',
    }),
  ]);
  return !contas[0] && !chaves[0];
}

// Reconfere na hora de apagar (review F2.27): o operador pode ter refeito o
// vinculo (billing:subscribe grava assinatura e metodo `pix`) enquanto as
// checagens acima rodavam, e o delete em cascata levaria o vinculo novo junto.
async function aindaAbandonado(env: Env, tenantId: string, limite: string): Promise<boolean> {
  const rows = await supabaseSelect<{ tenant_id: string }>(env, 'billing_subscriptions', {
    tenant_id: `eq.${tenantId}`,
    status: STATUS_FAXINA,
    payment_method: 'in.(card,pix_automatic)',
    asaas_subscription_id: 'is.null',
    updated_at: `lt.${limite}`,
    select: 'tenant_id',
    limit: '1',
  });
  return rows.length > 0;
}

export async function limparCheckoutsAbandonados(
  env: Env,
): Promise<{ removidos: number; mantidos: number }> {
  if (!env.ASAAS_API_KEY) {
    return { removidos: 0, mantidos: 0 };
  }
  const limite = new Date(Date.now() - IDADE_MINIMA_MS).toISOString();
  // updated_at, nao created_at: um vinculo que o operador refez (billing:
  // subscribe) ou que acabou de ser cancelado conta a partir da ultima mudanca.
  const pendentes = await supabaseSelect<PendenteRow>(env, 'billing_subscriptions', {
    status: STATUS_FAXINA,
    payment_method: 'in.(card,pix_automatic)',
    asaas_subscription_id: 'is.null',
    updated_at: `lt.${limite}`,
    order: 'updated_at.asc',
    select: SELECT_PENDENTE,
    limit: String(LOTE),
  });

  let removidos = 0;
  let mantidos = 0;
  for (const p of pendentes) {
    try {
      // Banco antes do Asaas: tenant com conta ou chave nunca tem nada
      // cancelado.
      if (
        (await nuncaValeu(env, p.tenant_id)) &&
        (await encerrarCheckout(env, p)) &&
        (await aindaAbandonado(env, p.tenant_id, limite))
      ) {
        await supabaseDelete(env, 'tenants', { id: `eq.${p.tenant_id}` });
        removidos += 1;
        continue;
      }
    } catch (err) {
      // Um item com erro nao para a faxina dos outros. Mensagens internas sao
      // codigos (supabase_*_failed:<status>, asaas_*), sem segredo.
      console.error(`limpeza_erro: ${p.tenant_id} ${err instanceof Error ? err.message : 'erro'}`);
    }
    mantidos += 1;
    // So o uuid do tenant (nosso), nunca dado de cobranca ou pessoal.
    console.error(`limpeza_mantido: ${p.tenant_id}`);
    // Vai para o fim da fila e so volta a ser olhado em 24h: um pendente que
    // nao pode sair nunca trava os de tras.
    await supabaseUpdate(
      env,
      'billing_subscriptions',
      { tenant_id: `eq.${p.tenant_id}`, asaas_subscription_id: 'is.null' },
      { updated_at: new Date().toISOString() },
    ).catch(() => {});
  }
  if (removidos || mantidos) {
    console.log(`limpeza_checkouts removidos=${removidos} mantidos=${mantidos}`);
  }
  return { removidos, mantidos };
}
