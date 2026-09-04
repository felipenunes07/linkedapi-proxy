import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { supabaseSelect, supabaseInsert, supabaseUpdate } from '../lib/supabase';
import { hashApiKey, secretsEqual } from '../lib/hash';
import { randomHex32 } from '../lib/random';
import { asRecord, pickString } from '../lib/sanitize';
import { createHostedAuthLink, getAccount } from '../lib/unipile';
import { deliverWebhook } from '../lib/webhooks';
import { enableCustomerNotifications } from '../lib/asaas';
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
  asaas_customer_id?: string;
  payment_method?: string;
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
// o evento sai sem link (o operador gera na mao).
async function buildReconnectLink(
  env: Env,
  tenantId: string,
  unipileAccountId: string,
): Promise<string | null> {
  const base = env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
  if (!base || !base.startsWith('https://')) {
    return null;
  }

  // Mesmo TTL do fluxo do operador (Marco 4): 2h. Se o cliente vir o evento
  // tarde e o link tiver expirado, o operador (ou um novo evento) gera outro.
  const token = `lk_conn_${randomHex32()}`;
  const expiresAtIso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  await supabaseInsert(env, 'connect_tokens', {
    tenant_id: tenantId,
    token_hash: await hashApiKey(token),
    purpose: 'reconnect',
    status: 'pending',
    expires_at: expiresAtIso,
  });

  const res = await createHostedAuthLink(env, {
    type: 'reconnect',
    reconnect_account: unipileAccountId,
    api_url: `https://${env.UNIPILE_DSN}`,
    expiresOn: expiresAtIso,
    name: token,
    notify_url: `${base}/hooks/connect`,
    single_use: true,
    disabled_features: [
      'linkedin_recruiter',
      'linkedin_sales_navigator',
      'linkedin_organizations_mailboxes',
    ],
  });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as { url?: string };
  return typeof data.url === 'string' ? data.url : null;
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
    await supabaseUpdate(
      c.env,
      'connected_accounts',
      { id: `eq.${account.id}`, status: 'eq.disconnected' },
      { status: 'active' },
    );
    fireAndForget(c, () =>
      notifyTenant(c.env, account.tenant_id, 'account.reconnected', {}),
    );
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
const BILLING_ACTIVE_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);
const BILLING_OVERDUE_EVENTS = new Set(['PAYMENT_OVERDUE']);

eventHooks.post('/billing', async (c) => {
  const denied = await gate(c, 'asaas-access-token', c.env.ASAAS_HOOK_TOKEN);
  if (denied) return denied;

  const body = await readJson(c);
  if (body instanceof Response) return body;

  const event = pickString(asRecord(body), 'event');
  const payment = asRecord(asRecord(body).payment);
  const subscriptionId = pickString(payment, 'subscription');
  // No Pix Automatico a assinatura nasce so depois que o pagador autoriza no
  // banco dele, entao a primeira cobranca pode chegar sem `subscription`. O
  // `customer` sempre vem e sempre foi gravado por nos: e a ancora confiavel.
  const customerId = pickString(payment, 'customer');
  if (!event) {
    return c.json({ error: 'invalid_payload' }, 400);
  }

  const goesActive = BILLING_ACTIVE_EVENTS.has(event);
  const goesOverdue = BILLING_OVERDUE_EVENTS.has(event);
  const chave = subscriptionId ?? customerId;
  if ((!goesActive && !goesOverdue) || !chave) {
    return c.json({ ok: true, ignored: true });
  }
  if (await entityThrottled(c, 'billing-sub', chave)) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  // Resolve por assinatura quando ela existe; senao (Pix Automatico), por
  // cliente. Os dois campos vem do NOSSO banco; o payload so fornece a chave
  // de busca, nunca a identidade do tenant.
  const filtro: Record<string, string> = subscriptionId
    ? { asaas_subscription_id: `eq.${subscriptionId}` }
    : { asaas_customer_id: `eq.${customerId}` };
  const subs = await supabaseSelect<BillingRow>(c.env, 'billing_subscriptions', {
    ...filtro,
    select: 'tenant_id,asaas_customer_id,payment_method',
    limit: '1',
  });
  const sub = subs[0];
  if (!sub) {
    // Assinatura que nao conhecemos: confirma e sinaliza (sem ids no log).
    console.error('billing_unknown_subscription');
    return c.json({ ok: true, ignored: true });
  }

  // Atualiza pelo tenant (chave primaria da tabela): funciona tanto quando
  // achamos por assinatura quanto por cliente. E aproveita para gravar o id da
  // assinatura na primeira vez que ele aparece (Pix Automatico so o revela
  // depois que o pagador autoriza).
  await supabaseUpdate(
    c.env,
    'billing_subscriptions',
    { tenant_id: `eq.${sub.tenant_id}` },
    {
      status: goesActive ? 'active' : 'overdue',
      updated_at: new Date().toISOString(),
      ...(subscriptionId ? { asaas_subscription_id: subscriptionId } : {}),
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
  }

  return c.json({ ok: true });
});
