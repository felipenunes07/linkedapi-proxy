import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { supabaseSelect, supabaseInsert } from '../lib/supabase';
import { attemptKey, bumpAttempts } from '../lib/throttle';
import { hashApiKey } from '../lib/hash';
import { apenasDigitos, documentoValido } from '../lib/documento';
import {
  createCustomer,
  createSubscription,
  cancelSubscription,
  firstPaymentId,
  pixQrCode,
} from '../lib/asaas';

// Checkout proprio (F2.14): o cliente assina sem sair da nossa marca.
//
// Rota PUBLICA que escreve no banco e cria registro financeiro. As camadas
// abaixo vieram do security review; cada uma fecha um caminho de abuso real:
//   1. FAIL-CLOSED: sem KV responde 500; sem ASAAS_API_KEY a rota nem existe.
//   2. CONTENT-TYPE application/json exigido. Sem isso um POST cross-site com
//      text/plain e "simple request": nao dispara preflight, o CORS nao ve, e
//      o handler executa no IP de cada visitante de um site malicioso (B1).
//   3. THROTTLE em tres eixos: por IP, GLOBAL (disjuntor de abuso distribuido)
//      e por DOCUMENTO hasheado (corta enumeracao que troca de IP).
//   4. DOCUMENTO validado por modulo 11 aqui: lixo nunca vira tenant nem
//      requisicao ao Asaas.
//   5. LOCK de idempotencia por e-mail+documento: duplo clique nao cria duas
//      assinaturas mensais para a mesma pessoa.
//   6. CAPACIDADE: nao vender seat que a conta-mestra nao tem.
//   7. ORDEM: cliente no Asaas (nao cobra) -> tenant -> assinatura (cobra) ->
//      vinculo. Se o vinculo falhar, a assinatura e CANCELADA no Asaas: cliente
//      cobrado sem vinculo seria irrecuperavel pelo webhook (B3).
//   8. A resposta carrega SO o necessario para pagar. Nunca tenant_id, ids do
//      Asaas ou segredos.

const MAX_ATTEMPTS_PER_IP = 10;
const MAX_ATTEMPTS_GLOBAL = 60;
const MAX_ATTEMPTS_PER_DOC = 3;
const LOCK_TTL_SECONDS = 15 * 60;
const DEFAULT_PRICE_BRL = 57;
const DEFAULT_SEAT_CAP = 10;

const MAX_NAME = 100;
const MAX_EMAIL = 150;

interface TenantRow {
  id: string;
}

interface AccountRow {
  id: string;
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export const checkout = new Hono<{ Bindings: Env; Variables: Variables }>();

checkout.post('/', async (c) => {
  if (!c.env.ASAAS_API_KEY) {
    return c.json({ error: 'not_found' }, 404);
  }
  const kv = c.env.RATE_LIMIT;
  if (!kv) {
    return c.json({ error: 'rate_limit_unavailable' }, 500);
  }

  // Camada 2: exigir application/json devolve ao preflight o papel de porteiro.
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return c.json({ error: 'invalid_content_type' }, 415);
  }

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const porIp = await bumpAttempts(kv, attemptKey('checkout-ip', ip));
  const global = await bumpAttempts(kv, attemptKey('checkout-global', 'all'));
  if (porIp > MAX_ATTEMPTS_PER_IP || global > MAX_ATTEMPTS_GLOBAL) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const { name, email, cpf_cnpj } = (body ?? {}) as Record<string, unknown>;

  if (typeof name !== 'string' || name.trim().length < 2 || name.length > MAX_NAME) {
    return c.json({ error: 'invalid_name' }, 400);
  }
  if (typeof email !== 'string' || email.length > MAX_EMAIL || !validEmail(email)) {
    return c.json({ error: 'invalid_email' }, 400);
  }
  if (typeof cpf_cnpj !== 'string') {
    return c.json({ error: 'invalid_document' }, 400);
  }
  const documento = apenasDigitos(cpf_cnpj);
  if (!documentoValido(documento)) {
    return c.json({ error: 'invalid_document' }, 400);
  }

  // Chaves de KV nunca carregam dado pessoal em claro: sempre o hash.
  const docHash = await hashApiKey(documento);
  const porDoc = await bumpAttempts(kv, attemptKey('checkout-doc', docHash));
  if (porDoc > MAX_ATTEMPTS_PER_DOC) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  // Camada 5: lock de idempotencia (duplo clique / reenvio do formulario).
  const lockKey = `checkout:lock:${await hashApiKey(`${email.toLowerCase()}|${documento}`)}`;
  if (await kv.get(lockKey)) {
    return c.json({ error: 'checkout_in_progress' }, 409);
  }
  await kv.put(lockKey, '1', { expirationTtl: LOCK_TTL_SECONDS });

  const price = Number(c.env.PLAN_PRICE_BRL ?? DEFAULT_PRICE_BRL);
  if (!Number.isFinite(price) || price <= 0) {
    return c.json({ error: 'internal_error' }, 500);
  }

  // Camada 6: capacidade de seats. Vender assinatura sem vaga na conta-mestra
  // cria cliente pagante que nao consegue conectar.
  const seatCap = Number(c.env.SEAT_CAP ?? DEFAULT_SEAT_CAP);
  try {
    const ativas = await supabaseSelect<AccountRow>(c.env, 'connected_accounts', {
      status: 'eq.active',
      provider: 'eq.linkedin',
      select: 'id',
    });
    if (Number.isFinite(seatCap) && ativas.length >= seatCap) {
      console.error('checkout_sold_out');
      return c.json({ error: 'sold_out' }, 503);
    }
  } catch {
    console.error('checkout_capacity_check_failed');
    return c.json({ error: 'internal_error' }, 500);
  }

  // Camada 7, passo 1: cliente no Asaas. NAO gera cobranca, entao e o lugar
  // certo para descobrir documento/e-mail recusados sem sujar o banco.
  let customerId: string;
  try {
    customerId = await createCustomer(c.env, {
      name: name.trim(),
      email,
      cpfCnpj: documento,
      externalReference: 'checkout',
      // Notificacao do Asaas DESLIGADA: a comunicacao com o cliente e nossa.
      // Ligada, permitiria disparar cobranca por e-mail contra terceiros (B2).
      notificationsEnabled: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.name : 'erro';
    if (err instanceof Error && err.message.startsWith('asaas_customer_failed:400')) {
      return c.json({ error: 'invalid_document' }, 400);
    }
    console.error(`checkout_customer_failed: ${message}`);
    return c.json({ error: 'billing_unavailable' }, 502);
  }

  // Passo 2: tenant.
  let tenantId: string;
  try {
    const rows = await supabaseInsert<TenantRow>(c.env, 'tenants', {
      name: name.trim(),
      status: 'active',
    });
    const created = rows[0];
    if (!created?.id) {
      throw new Error('tenant_insert_no_row');
    }
    tenantId = created.id;
  } catch {
    console.error('checkout_tenant_failed');
    return c.json({ error: 'internal_error' }, 500);
  }

  // Passo 3: assinatura. A partir daqui existe cobranca real.
  let subscriptionId: string;
  try {
    subscriptionId = await createSubscription(c.env, {
      customerId,
      value: price,
      description: 'LinkedAPI, 1 conta de LinkedIn conectada',
      externalReference: tenantId,
    });
  } catch (err) {
    console.error(
      `checkout_subscription_failed: ${err instanceof Error ? err.name : 'erro'}`,
    );
    return c.json({ error: 'billing_unavailable' }, 502);
  }

  // Passo 4: vinculo. E por ele que /hooks/billing acha o tenant. Se falhar,
  // desfaz a assinatura: melhor nao vender do que cobrar sem poder ativar.
  try {
    await supabaseInsert(c.env, 'billing_subscriptions', {
      tenant_id: tenantId,
      asaas_customer_id: customerId,
      asaas_subscription_id: subscriptionId,
      status: 'pending',
      updated_at: new Date().toISOString(),
    });
  } catch {
    const cancelada = await cancelSubscription(c.env, subscriptionId).catch(
      () => false,
    );
    // O id do Asaas NAO e segredo e e o unico fio para reconciliar a mao caso
    // o cancelamento tambem falhe.
    console.error(
      `checkout_orphan_subscription: ${subscriptionId} cancelada=${cancelada}`,
    );
    return c.json({ error: 'billing_unavailable' }, 502);
  }

  // Passo 5: QR do Pix. Se nao vier, a assinatura existe e o cliente recebe a
  // cobranca de outras formas: respondemos ok sem QR em vez de falhar.
  let pix: { image: string; code: string; expires_at: string | null } | null = null;
  try {
    const paymentId = await firstPaymentId(c.env, subscriptionId);
    if (paymentId) {
      const qr = await pixQrCode(c.env, paymentId);
      if (qr?.payload) {
        pix = {
          image: qr.encodedImage ?? '',
          code: qr.payload,
          expires_at: qr.expirationDate ?? null,
        };
      }
    }
  } catch {
    console.error('checkout_pix_unavailable');
  }

  return c.json({ ok: true, data: { value: price, pix } });
});
