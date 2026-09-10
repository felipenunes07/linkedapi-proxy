import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { supabaseSelect, supabaseUpdate } from '../lib/supabase';
import { secretsEqual } from '../lib/hash';
import { asRecord, pickString } from '../lib/sanitize';
import { getAccount } from '../lib/unipile';
import { createConnectLink, enviarBoasVindas } from '../lib/portal';
import { deliverWebhook } from '../lib/webhooks';
import {
  enableCustomerNotifications,
  getPayment,
  listPayments,
  STATUS_PAGOS,
} from '../lib/asaas';
import { statusAoReativar } from '../lib/billing';
import { fireAndForget } from '../lib/async';
import { attemptKey, bumpAttempts } from '../lib/throttle';

// Hooks de evento (fase 2). Tres rotas publicas, todas atras de secret
// compartilhado configurado na origem (fail-closed: sem o secret no env, a
// rota responde 500 e nada e processado):
//
//   POST /hooks/account-status   status de conta da origem (webhook registrado
//                                por webhook:register). Sessao caiu -> conta
//                                vira disconnected + notifica o tenant com um
//                                link de reconexao; voltou -> active.
//   POST /hooks/message-received mensagem nova na origem -> repassa ao webhook
//                                do tenant, sanitizada e assinada (HMAC).
//   POST /hooks/billing          eventos de cobranca (Asaas). Pagamento em
//                                atraso PAUSA as contas do tenant (nunca
//                                deleta); pagamento confirmado despausa.
//
// Nenhuma dessas rotas confia em ids do payload para decidir tenant: a conta/
// assinatura e resolvida no banco, e payload desconhecido vira 200 ignored.
// Nada de payload e logado.

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

interface AccountRow {
  id: string;
  tenant_id: string;
  status: string;
  unipile_account_id: string;
}

interface TenantWebhookRow {
  id: string;
  webhook_url: string | null;
  webhook_secret: string | null;
}

interface BillingRow {
  tenant_id: string;
  asaas_customer_id?: string | null;
  asaas_subscription_id?: string | null;
  payment_method?: string | null;
}

// Tetos de tentativa (janela diaria UTC, mesmos contadores KV do /hooks/connect).
// Por IP alto: os egress da origem concentram trafego legitimo (mensagens).
// Por entidade (conta/assinatura) segura loop de abuso com secret comprometido.
const HOOK_IP_DAILY_LIMIT = 5000;
const ENTITY_DAILY_LIMITS = {
  'status-acct': 50, // mudancas de status de sessao por conta/dia
  'msg-acct': 2000, // mensagens recebidas por conta/dia
  'billing-sub': 50, // eventos de cobranca por assinatura/dia
} as const;

// Gate padrao das rotas de hook: exige KV (fail-closed, como o rate limit),
// valida o secret compartilhado (hash-compare, timing-safe) e conta a
// tentativa por IP ANTES de tocar banco ou origem.
async function gate(
  c: Ctx,
  headerName: string,
  expected: string | undefined,
): Promise<Response | null> {
  const kv = c.env.RATE_LIMIT;
  if (!kv) {
    return c.json({ error: 'rate_limit_unavailable' }, 500);
  }
  if (!expected) {
    return c.json({ error: 'hook_unavailable' }, 500);
  }
  const provided = c.req.header(headerName);
  if (!provided || !(await secretsEqual(provided, expected))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  if ((await bumpAttempts(kv, attemptKey('hook-ip', ip))) > HOOK_IP_DAILY_LIMIT) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  return null;
}

// Teto por entidade (conta/assinatura), depois do parse do payload.
async function entityThrottled(
  c: Ctx,
  scope: keyof typeof ENTITY_DAILY_LIMITS,
  id: string,
): Promise<boolean> {
  const attempts = await bumpAttempts(
    c.env.RATE_LIMIT,
    attemptKey(scope, id),
  );
  return attempts > ENTITY_DAILY_LIMITS[scope];
}

async function readJson(c: Ctx): Promise<unknown | Response> {
  try {
    return await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
}

// Entrega um evento ao webhook do tenant, se configurado. Best-effort.
// Tenant suspenso nao recebe evento (filtro status=active).
async function notifyTenant(
  env: Env,
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const rows = await supabaseSelect<TenantWebhookRow>(env, 'tenants', {
    id: `eq.${tenantId}`,
    status: 'eq.active',
    select: 'id,webhook_url,webhook_secret',
    limit: '1',
  });
  const tenant = rows[0];
  if (!tenant?.webhook_url || !tenant.webhook_secret) {
    return;
  }
  await deliverWebhook(tenant.webhook_url, tenant.webhook_secret, eventType, payload);
}

// Reconexao automatizada: gera um link de reconexao (mesmo desenho do
// connect:reconnect do operador: token de uso unico, so hash no banco) para
// incluir no evento ao tenant. Sem PUBLIC_BASE_URL configurada, retorna null e
// o evento sai sem link (o cliente reconecta pelo painel, ou o operador gera
// na mao). O link expira em 2h; o painel gera outro quando precisar. Sem
// voltarAoPainel: quem recebe este link e o usuario final do integrador, que
// nao tem sessao no nosso painel (review M5).
async function buildReconnectLink(
  env: Env,
  tenantId: string,
  unipileAccountId: string,
): Promise<string | null> {
  const link = await createConnectLink(env, tenantId, 'reconnect', unipileAccountId);
  return link?.url ?? null;
}

// Status vindos da origem que significam "sessao caiu" / "sessao ok".
const DOWN_STATUSES = new Set(['CREDENTIALS', 'DISCONNECTED', 'ERROR', 'STOPPED']);
const UP_STATUSES = new Set(['OK', 'CREATION_SUCCESS', 'RECONNECTED', 'SYNC_SUCCESS']);

export const eventHooks = new Hono<{ Bindings: Env; Variables: Variables }>();

eventHooks.post('/account-status', async (c) => {
  const denied = await gate(c, 'x-hook-secret', c.env.ACCOUNT_STATUS_HOOK_SECRET);
  if (denied) return denied;

  const body = await readJson(c);
  if (body instanceof Response) return body;

  const status = asRecord(asRecord(body).AccountStatus);
  const accountId = pickString(status, 'account_id');
  const message = pickString(status, 'message');
  if (!accountId || !message) {
    return c.json({ error: 'invalid_payload' }, 400);
  }
  if (!DOWN_STATUSES.has(message) && !UP_STATUSES.has(message)) {
    return c.json({ ok: true, ignored: true });
  }

  if (await entityThrottled(c, 'status-acct', accountId)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const rows = await supabaseSelect<AccountRow>(c.env, 'connected_accounts', {
    unipile_account_id: `eq.${accountId}`,
    select: 'id,tenant_id,status,unipile_account_id',
    limit: '1',
  });
  const account = rows[0];
  if (!account) {
    return c.json({ ok: true, ignored: true });
  }

  // Pausa (billing) nao muda por status de sessao; e os updates filtram o
  // status atual para serem idempotentes sob retry do webhook.
  if (DOWN_STATUSES.has(message) && account.status === 'active') {
    // Nunca confiar so no payload para derrubar uma conta (mesmo principio do
    // callback de conexao): se a origem disser que a sessao esta OK, ignora.
    // Origem inalcancavel = segue o payload (ele ja passou pelo secret).
    try {
      const upstream = await getAccount(c.env, accountId);
      if (upstream.ok) {
        const acc = asRecord(await upstream.json());
        const sources = Array.isArray(acc.sources) ? acc.sources : [];
        if (pickString(asRecord(sources[0]), 'status') === 'OK') {
          return c.json({ ok: true, ignored: true });
        }
      }
    } catch {
      // origem fora do ar: prossegue com o payload autenticado
    }

    await supabaseUpdate(
      c.env,
      'connected_accounts',
      { id: `eq.${account.id}`, status: 'eq.active' },
      { status: 'disconnected' },
    );
    fireAndForget(c, async () => {
      // Falha na geracao do link NUNCA pode engolir a notificacao: o cliente
      // precisa saber que a conta caiu mesmo sem link (achado I1 do review).
      let reconnectUrl: string | null = null;
      try {
        reconnectUrl = await buildReconnectLink(
          c.env,
          account.tenant_id,
          account.unipile_account_id,
        );
      } catch {
        console.error('reconnect_link_failed');
      }
      await notifyTenant(c.env, account.tenant_id, 'account.disconnected', {
        reconnect_url: reconnectUrl,
        reconnect_expires_in_hours: reconnectUrl ? 2 : null,
      });
    });
  } else if (UP_STATUSES.has(message) && account.status === 'disconnected') {
    // A sessao voltou, mas a inadimplencia continua valendo: conta que estava
    // desconectada no dia do atraso nao escapa da pausa (review F2.25, #3).
    const novo = await statusAoReativar(c.env, account.tenant_id);
    await supabaseUpdate(
      c.env,
      'connected_accounts',
      { id: `eq.${account.id}`, status: 'eq.disconnected' },
      { status: novo },
    );
    if (novo === 'active') {
      fireAndForget(c, () =>
        notifyTenant(c.env, account.tenant_id, 'account.reconnected', {}),
      );
    }
  }

  return c.json({ ok: true });
});

eventHooks.post('/message-received', async (c) => {
  const denied = await gate(c, 'x-hook-secret', c.env.MESSAGE_HOOK_SECRET);
  if (denied) return denied;

  const body = await readJson(c);
  if (body instanceof Response) return body;

  const event = asRecord(body);
  const accountId = pickString(event, 'account_id');
  if (!accountId) {
    return c.json({ error: 'invalid_payload' }, 400);
  }
  if (await entityThrottled(c, 'msg-acct', accountId)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const rows = await supabaseSelect<AccountRow>(c.env, 'connected_accounts', {
    unipile_account_id: `eq.${accountId}`,
    select: 'id,tenant_id,status,unipile_account_id',
    limit: '1',
  });
  const account = rows[0];
  // Conta desconhecida ou fora de operacao (pausada por inadimplencia,
  // desconectada): nada e repassado ao cliente.
  if (!account || account.status !== 'active') {
    return c.json({ ok: true, ignored: true });
  }

  // Whitelist (mesma disciplina do sanitize.ts): nada de account_id nem campos
  // internos da origem no evento que sai para o cliente.
  const sender = asRecord(event.sender);
  const payload = {
    chat_id: pickString(event, 'chat_id'),
    message_id: pickString(event, 'message_id'),
    text: pickString(event, 'message'),
    attendee_provider_id: pickString(sender, 'attendee_provider_id'),
    sender_name: pickString(sender, 'attendee_name'),
    timestamp: pickString(event, 'timestamp'),
  };

  fireAndForget(c, () =>
    notifyTenant(c.env, account.tenant_id, 'message.received', payload),
  );

  return c.json({ ok: true });
});

// Eventos de pagamento -> status da assinatura + pausa/despausa das contas.
// CHECKOUT_PAID (F2.25): o checkout de cartao foi pago.
// PAYMENT_CHARGEBACK_REQUESTED (review F2.25): o pagador contestou a cobranca
// do cartao. Mesma regra do atraso: pausa, nunca deleta.
const BILLING_ACTIVE_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'CHECKOUT_PAID']);
const BILLING_OVERDUE_EVENTS = new Set(['PAYMENT_OVERDUE', 'PAYMENT_CHARGEBACK_REQUESTED']);

eventHooks.post('/billing', async (c) => {
  const denied = await gate(c, 'asaas-access-token', c.env.ASAAS_HOOK_TOKEN);
  if (denied) return denied;

  const body = await readJson(c);
  if (body instanceof Response) return body;

  const raiz = asRecord(body);
  const event = pickString(raiz, 'event');
  if (!event) {
    return c.json({ error: 'invalid_payload' }, 400);
  }
  // Cobranca (PAYMENT_*) ou checkout pago (CHECKOUT_PAID, cartao). O payload so
  // fornece CHAVES DE BUSCA; a identidade do tenant vem sempre do nosso banco.
  const payment = asRecord(raiz.payment);
  const checkout = asRecord(raiz.checkout);
  const paymentId = pickString(payment, 'id');
  const cartao = pickString(payment, 'billingType') === 'CREDIT_CARD';
  let subscriptionId = pickString(payment, 'subscription');
  let customerId = pickString(payment, 'customer') ?? pickString(checkout, 'customer');
  // Cartao (F2.25): a ancora e a sessao de checkout que NOS criamos. Vem em
  // payment.checkoutSession (quando o Asaas manda) e, no CHECKOUT_PAID, em
  // checkout.id. Sem ela no payload, e buscada no Asaas mais abaixo.
  let checkoutSession =
    pickString(payment, 'checkoutSession') ??
    (event === 'CHECKOUT_PAID' ? pickString(checkout, 'id') : undefined);

  // Review F2.25 (#1): no cartao, PAYMENT_RECEIVED e so a LIQUIDACAO (~30 dias
  // depois) de uma cobranca que ja chegou como CONFIRMED e ja ativou. Se
  // valesse, a liquidacao do mes 1 desfaria a pausa de um atraso do mes 2.
  if (event === 'PAYMENT_RECEIVED' && cartao) {
    return c.json({ ok: true, ignored: true });
  }

  const goesActive = BILLING_ACTIVE_EVENTS.has(event);
  const goesOverdue = BILLING_OVERDUE_EVENTS.has(event);
  const chave = checkoutSession ?? subscriptionId ?? customerId ?? paymentId;
  if ((!goesActive && !goesOverdue) || !chave) {
    return c.json({ ok: true, ignored: true });
  }
  if (await entityThrottled(c, 'billing-sub', chave)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  // Ordem de resolucao (review F2.25, B1):
  //   1. sessao de checkout (cartao): id que NOS criamos, unico no banco;
  //   2. assinatura ja conhecida;
  //   3. cliente, SO no Pix Automatico: e o unico metodo em que o cliente do
  //      Asaas foi criado por nos. No cartao o cliente nasce na pagina do Asaas
  //      a partir do que o pagador digitou (e pode ser um cadastro reaproveitado
  //      por CPF), entao NUNCA serve de ancora.
  const buscar = async (filtro: Record<string, string>) =>
    (
      await supabaseSelect<BillingRow>(c.env, 'billing_subscriptions', {
        ...filtro,
        select: 'tenant_id,asaas_customer_id,asaas_subscription_id,payment_method',
        limit: '1',
      })
    )[0];
  let sub: BillingRow | undefined;
  if (checkoutSession) {
    sub = await buscar({ asaas_checkout_id: `eq.${checkoutSession}` });
  }
  if (!sub && subscriptionId) {
    sub = await buscar({ asaas_subscription_id: `eq.${subscriptionId}` });
  }
  if (!sub && customerId && !cartao) {
    sub = await buscar({
      asaas_customer_id: `eq.${customerId}`,
      payment_method: 'eq.pix_automatic',
    });
  }
  // Review F2.25 (#2): checkoutSession nao esta no payload DOCUMENTADO do
  // webhook. Cobranca que nao casou com nada: pergunta ao Asaas de qual sessao
  // ela veio (objeto oficial da cobranca, pelo id do evento ja autenticado).
  if (!sub && paymentId && !checkoutSession) {
    const real = await getPayment(c.env, paymentId).catch(() => null);
    if (real?.checkoutSession) {
      checkoutSession = real.checkoutSession;
      sub = await buscar({ asaas_checkout_id: `eq.${real.checkoutSession}` });
      subscriptionId ??= real.subscription;
      customerId ??= real.customer;
    }
  }
  if (!sub) {
    // Assinatura que nao conhecemos: confirma e sinaliza (sem ids no log).
    console.error('billing_unknown_subscription');
    return c.json({ ok: true, ignored: true });
  }

  // CHECKOUT_PAID traz so a sessao: assinatura e cliente vem da cobranca que
  // ela gerou (sem eles, o mes 2 do cartao nao acharia o tenant).
  if (event === 'CHECKOUT_PAID' && checkoutSession && (!subscriptionId || !customerId)) {
    const cobrancas = await listPayments(c.env, { checkoutSession }, 1).catch(() => null);
    const primeira = cobrancas?.[0];
    if (primeira) {
      subscriptionId ??= primeira.subscription;
      customerId ??= primeira.customer;
    }
  }

  // Nunca SOBRESCREVER o vinculo: uma assinatura diferente da ja gravada e
  // conflito (ex.: segunda assinatura do mesmo cliente), nunca troca
  // silenciosa. Sinal interno so com o uuid do tenant (nosso).
  if (
    subscriptionId &&
    sub.asaas_subscription_id &&
    sub.asaas_subscription_id !== subscriptionId
  ) {
    console.error(`billing_subscription_conflict: ${sub.tenant_id}`);
    return c.json({ ok: true, ignored: true });
  }

  // Preenche os ids que ainda faltam (Pix Automatico so revela a assinatura
  // depois da autorizacao; no cartao o Asaas cria o cliente). Filtro is.null:
  // sob corrida, quem chega depois nao troca o que o primeiro gravou.
  if (subscriptionId && !sub.asaas_subscription_id) {
    await supabaseUpdate(
      c.env,
      'billing_subscriptions',
      { tenant_id: `eq.${sub.tenant_id}`, asaas_subscription_id: 'is.null' },
      { asaas_subscription_id: subscriptionId },
    );
  }
  if (customerId && !sub.asaas_customer_id) {
    await supabaseUpdate(
      c.env,
      'billing_subscriptions',
      { tenant_id: `eq.${sub.tenant_id}`, asaas_customer_id: 'is.null' },
      { asaas_customer_id: customerId },
    );
  }

  // Review F2.25 (#1, ordem): o Asaas entrega em fila e reentrega; um evento
  // velho nunca vence o estado atual da cobranca.
  if (event === 'PAYMENT_OVERDUE' && paymentId) {
    // Atraso de uma cobranca que, no Asaas, ja foi paga: evento velho.
    const atual = await getPayment(c.env, paymentId).catch(() => null);
    if (atual && STATUS_PAGOS.has(atual.status)) {
      console.error(`billing_overdue_stale: ${sub.tenant_id}`);
      return c.json({ ok: true, ignored: true });
    }
  }
  if (goesActive) {
    // Pagamento de uma cobranca enquanto OUTRA da mesma assinatura segue
    // vencida (ex.: confirmacao atrasada do mes 1 depois do atraso do mes 2):
    // continua pausado. Asaas sem resposta: vale o evento (ele e autenticado).
    const assinatura = subscriptionId ?? sub.asaas_subscription_id ?? undefined;
    if (assinatura) {
      const vencidas = await listPayments(
        c.env,
        { subscription: assinatura, status: 'OVERDUE' },
        1,
      ).catch(() => null);
      if (vencidas && vencidas.length > 0) {
        console.error(`billing_still_overdue: ${sub.tenant_id}`);
        return c.json({ ok: true, ignored: true });
      }
    }
  }
  await supabaseUpdate(
    c.env,
    'billing_subscriptions',
    { tenant_id: `eq.${sub.tenant_id}` },
    {
      status: goesActive ? 'active' : 'overdue',
      updated_at: new Date().toISOString(),
    },
  );

  if (goesOverdue) {
    // Regra do PRD: inadimplencia PAUSA (nunca deleta). Pausa nao e tocada
    // pelo hook de status de sessao nem pela reconexao.
    await supabaseUpdate(
      c.env,
      'connected_accounts',
      { tenant_id: `eq.${sub.tenant_id}`, status: 'eq.active' },
      { status: 'paused' },
    );
  } else {
    await supabaseUpdate(
      c.env,
      'connected_accounts',
      { tenant_id: `eq.${sub.tenant_id}`, status: 'eq.paused' },
      { status: 'active' },
    );

    // F2.16: cliente que pagou por PIX passa a receber os avisos do Asaas. A
    // assinatura Pix nao debita sozinha (o Asaas emite cobranca nova a cada
    // ciclo e o cliente paga na mao), entao sem o aviso mensal ele nao paga o
    // mes 2 e a conta pausa.
    //
    // SO para Pix MANUAL, e decidido pelo metodo que NOS gravamos, nunca pelo
    // payload. Pix Automatico e cartao debitam sozinhos e nao precisam de
    // aviso; religar neles reabriria, de forma automatica, a cobranca por
    // e-mail contra o endereco que o pagador digitou. Metodo desconhecido nao
    // religa.
    if (sub.asaas_customer_id && sub.payment_method === 'pix') {
      fireAndForget(c, async () => {
        const ok = await enableCustomerNotifications(c.env, sub.asaas_customer_id!);
        if (!ok) console.error('billing_enable_notifications_failed');
      });
    }

    // F2.20/F2.21: boas-vindas com o link do painel (conectar o LinkedIn e
    // gerar a chave). Roda em todo pagamento confirmado: enviarBoasVindas
    // reivindica tenants.welcome_sent_at, entao sai uma vez so (mesmo com
    // retry ou evento em dobro) e tenta de novo no proximo evento se o envio
    // falhar. Sem e-mail configurado nada acontece: o link do painel ja ficou
    // salvo no navegador de quem pagou pela tela do checkout.
    fireAndForget(c, () => enviarBoasVindas(c.env, sub.tenant_id));
  }

  return c.json({ ok: true });
});
