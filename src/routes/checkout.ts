import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { supabaseSelect, supabaseInsert, supabaseDelete } from '../lib/supabase';
import { attemptKey, bumpAttempts } from '../lib/throttle';
import { hashApiKey } from '../lib/hash';
import { apenasDigitos, documentoValido } from '../lib/documento';
import {
  createCustomer,
  createPixAutomaticAuthorization,
  cancelPixAutomaticAuthorization,
} from '../lib/asaas';

// Checkout proprio (F2.14, reformulado em F2.18): o cliente assina sem sair da
// nossa marca, pagando com PIX AUTOMATICO.
//
// Por que so Pix aqui: o Asaas nao oferece tokenizacao de cartao no navegador e
// exige SAQ-D de quem digita cartao em pagina propria. Pix nao e cartao, entao
// este caminho fica FORA do escopo PCI, com a nossa marca na tela E com
// cobranca automatica (o pagador autoriza uma vez no QR e o Asaas debita
// sozinho nos meses seguintes). Quem prefere cartao vai para um link hospedado
// pelo Asaas, e nenhum dado de cartao passa por aqui.
//
// Rota PUBLICA que escreve no banco e cria registro financeiro. Camadas (todas
// vindas do security review; cada uma fecha um abuso real):
//   1. FAIL-CLOSED: sem KV responde 500; sem ASAAS_API_KEY a rota nem existe.
//   2. CONTENT-TYPE application/json exigido. Sem isso um POST cross-site com
//      text/plain e "simple request": nao dispara preflight, o CORS nao ve, e
//      o handler executa no IP de cada visitante de um site malicioso.
//   3. THROTTLE por IP (checado e retornado ANTES de tocar o contador global,
//      senao um IP abusivo derruba as vendas do dia), GLOBAL e por DOCUMENTO
//      hasheado.
//   4. DOCUMENTO validado por modulo 11: lixo nunca vira tenant nem requisicao.
//   5. LOCK de idempotencia por e-mail+documento, liberado em toda falha.
//   6. CAPACIDADE: nao vender seat que a conta-mestra nao tem.
//   7. ORDEM: cliente (nao cobra) -> tenant -> autorizacao (cobra) -> vinculo.
//      Se o vinculo falhar, a autorizacao e CANCELADA: cliente cobrado sem
//      vinculo seria irrecuperavel pelo webhook.
//   8. A resposta carrega SO o QR. Nunca tenant_id, ids do Asaas ou segredos.

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

  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return c.json({ error: 'invalid_content_type' }, 415);
  }

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const porIp = await bumpAttempts(kv, attemptKey('checkout-ip', ip));
  if (porIp > MAX_ATTEMPTS_PER_IP) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const global = await bumpAttempts(kv, attemptKey('checkout-global', 'all'));
  if (global > MAX_ATTEMPTS_GLOBAL) {
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

  const lockKey = `checkout:lock:${await hashApiKey(`${email.toLowerCase()}|${documento}`)}`;
  if (await kv.get(lockKey)) {
    return c.json({ error: 'checkout_in_progress' }, 409);
  }
  await kv.put(lockKey, '1', { expirationTtl: LOCK_TTL_SECONDS });
  const liberarLock = () => kv.delete(lockKey).catch(() => {});

  const price = Number(c.env.PLAN_PRICE_BRL ?? DEFAULT_PRICE_BRL);
  if (!Number.isFinite(price) || price <= 0) {
    await liberarLock();
    return c.json({ error: 'internal_error' }, 500);
  }

  // Camada 6: nao vender seat que a conta-mestra nao tem.
  const seatCap = Number(c.env.SEAT_CAP ?? DEFAULT_SEAT_CAP);
  try {
    const ativas = await supabaseSelect<AccountRow>(c.env, 'connected_accounts', {
      status: 'eq.active',
      provider: 'eq.linkedin',
      select: 'id',
    });
    if (Number.isFinite(seatCap) && ativas.length >= seatCap) {
      console.error('checkout_sold_out');
      await liberarLock();
      return c.json({ error: 'sold_out' }, 503);
    }
  } catch {
    console.error('checkout_capacity_check_failed');
    await liberarLock();
    return c.json({ error: 'internal_error' }, 500);
  }

  // Passo 1: cliente no Asaas. NAO gera cobranca, entao e o lugar certo para
  // descobrir documento/e-mail recusados sem sujar o banco.
  let customerId: string;
  try {
    customerId = await createCustomer(c.env, {
      name: name.trim(),
      email,
      cpfCnpj: documento,
      externalReference: 'checkout',
      // Notificacao do Asaas desligada ate o primeiro pagamento: senao
      // qualquer um dispara cobranca por e-mail contra o CPF de um terceiro.
      notificationsEnabled: false,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('asaas_customer_failed:400')) {
      await liberarLock();
      return c.json({ error: 'invalid_document' }, 400);
    }
    console.error(
      `checkout_customer_failed: ${err instanceof Error ? err.name : 'erro'}`,
    );
    await liberarLock();
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
    await liberarLock();
    return c.json({ error: 'internal_error' }, 500);
  }

  // Passo 3: autorizacao do Pix Automatico. A partir daqui existe cobranca.
  let authorizationId: string;
  let qr: { image: string; code: string; expires_at: string | null } | null;
  try {
    const resultado = await createPixAutomaticAuthorization(c.env, {
      customerId,
      value: price,
      description: 'LinkedAPI 1 conta LinkedIn',
      // contractId tem teto de 35 caracteres; o uuid sem hifens cabe em 32.
      contractId: tenantId.replace(/-/g, ''),
    });
    authorizationId = resultado.authorizationId;
    qr = resultado.qr;
  } catch (err) {
    // O tenant nasceu e nao chegou a valer (sem chave, sem conta, sem
    // cobranca): remover evita acumular lixo por erro transitorio.
    await supabaseDelete(c.env, 'tenants', { id: `eq.${tenantId}` }).catch(() => {
      console.error(`checkout_orphan_tenant: ${tenantId}`);
    });
    console.error(
      `checkout_authorization_failed: ${err instanceof Error ? err.name : 'erro'}`,
    );
    await liberarLock();
    return c.json({ error: 'billing_unavailable' }, 502);
  }

  // Passo 4: vinculo. E por ele que /hooks/billing acha o tenant quando a
  // cobranca chegar. Se falhar, desfaz a autorizacao: melhor nao vender do que
  // cobrar sem poder ativar.
  try {
    await supabaseInsert(c.env, 'billing_subscriptions', {
      tenant_id: tenantId,
      asaas_customer_id: customerId,
      asaas_authorization_id: authorizationId,
      payment_method: 'pix_automatic',
      status: 'pending',
      updated_at: new Date().toISOString(),
    });
  } catch {
    const cancelada = await cancelPixAutomaticAuthorization(
      c.env,
      authorizationId,
    ).catch(() => false);
    // O id da autorizacao NAO e segredo e e o unico fio para reconciliar a mao
    // caso o cancelamento tambem falhe.
    console.error(
      `checkout_orphan_authorization: ${authorizationId} cancelada=${cancelada}`,
    );
    await liberarLock();
    return c.json({ error: 'billing_unavailable' }, 502);
  }

  return c.json({ ok: true, data: { value: price, method: 'pix_automatic', pix: qr } });
});
