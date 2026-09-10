import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { supabaseInsert, supabaseDelete } from '../lib/supabase';
import { attemptKey, bumpAttempts } from '../lib/throttle';
import { hashApiKey } from '../lib/hash';
import { apenasDigitos, documentoValido, emailValido } from '../lib/documento';
import {
  createCustomer,
  createPixAutomaticAuthorization,
  cancelPixAutomaticAuthorization,
  createCardCheckout,
  cancelCardCheckout,
  cardCheckoutStatus,
} from '../lib/asaas';
import { createPortalToken, seatsInUse, portalUrl } from '../lib/portal';

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
//   8. A resposta carrega SO o QR e o token do painel do PROPRIO comprador
//      (F2.20: e com ele que o cliente conecta o LinkedIn e gera a chave,
//      sem operador). Nunca tenant_id, ids do Asaas ou segredos nossos.

const MAX_ATTEMPTS_PER_IP = 10;
const MAX_ATTEMPTS_GLOBAL = 60;
const MAX_ATTEMPTS_PER_DOC = 3;
const LOCK_TTL_SECONDS = 15 * 60;
const DEFAULT_PRICE_BRL = 57;
const DEFAULT_SEAT_CAP = 10;
// Validade do QR do Pix Automatico (immediateQrCode.expirationSeconds em
// lib/asaas.ts). Checkout pendente dentro dela ainda "segura" um seat.
const PIX_VALIDADE_MS = 60 * 60 * 1000;

const MAX_NAME = 100;
const MAX_EMAIL = 150;

interface TenantRow {
  id: string;
}

// Texto da cobranca no Asaas. Neutro de proposito: o nome do produto ainda e
// provisorio. O Pix Automatico aceita no maximo 35 caracteres.
const DESCRICAO_PLANO = 'Plano mensal 1 conta LinkedIn';

// Sessao de cartao vive 60 min no Asaas; o lock acompanha, para reuso.
const CARD_LOCK_TTL_SECONDS = 60 * 60;

function lerLockCartao(valor: string): { id: string; url: string } | null {
  if (!valor.startsWith('card:')) return null;
  const resto = valor.slice(5);
  const corte = resto.indexOf('|');
  if (corte <= 0) return null;
  const id = resto.slice(0, corte);
  const url = resto.slice(corte + 1);
  return url.startsWith('https://') ? { id, url } : null;
}

// Sessao do painel do comprador (F2.20). Falha aqui NAO desfaz a venda: a
// cobranca ja esta vinculada e o acesso sai no e-mail de boas-vindas (ou pelo
// portal:link do operador).
async function criarSessaoDoComprador(
  env: Env,
  tenantId: string,
): Promise<{ token: string; expires_at: string } | null> {
  try {
    const criado = await createPortalToken(env, tenantId);
    return { token: criado.token, expires_at: criado.expiresAt };
  } catch {
    console.error('checkout_portal_token_failed');
    return null;
  }
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

  const { name, email, cpf_cnpj, payment_method } = (body ?? {}) as Record<string, unknown>;

  // F2.25: Pix Automatico (padrao) ou cartao recorrente no checkout HOSPEDADO
  // do Asaas. Qualquer outro valor e recusado antes de tocar em qualquer coisa.
  const metodo =
    payment_method === undefined || payment_method === 'pix_automatic'
      ? 'pix_automatic'
      : payment_method === 'card'
        ? 'card'
        : null;
  if (!metodo) {
    return c.json({ error: 'invalid_payment_method' }, 400);
  }

  if (typeof name !== 'string' || name.trim().length < 2 || name.length > MAX_NAME) {
    return c.json({ error: 'invalid_name' }, 400);
  }
  if (typeof email !== 'string' || email.length > MAX_EMAIL || !emailValido(email.trim())) {
    return c.json({ error: 'invalid_email' }, 400);
  }
  // Normalizado uma vez: o mesmo valor vai para o lock, o Asaas e o
  // tenants.contact_email (onde o "entrar no painel" procura).
  const emailNorm = email.trim().toLowerCase();
  if (typeof cpf_cnpj !== 'string') {
    return c.json({ error: 'invalid_document' }, 400);
  }
  const documento = apenasDigitos(cpf_cnpj);
  if (!documentoValido(documento)) {
    return c.json({ error: 'invalid_document' }, 400);
  }

  const lockKey = `checkout:lock:${await hashApiKey(`${emailNorm}|${documento}`)}`;
  const lockAtual = await kv.get(lockKey);
  if (lockAtual) {
    // Cartao (review F2.25, I1): quem volta do Asaas pelo "cancelar" ou
    // recarrega a pagina REUSA a mesma sessao enquanto ela estiver ativa, em
    // vez de travar em 409 ou abrir uma segunda assinatura (cobranca dupla).
    const anterior = metodo === 'card' ? lerLockCartao(lockAtual) : null;
    if (!anterior) {
      return c.json({ error: 'checkout_in_progress' }, 409);
    }
    const status = await cardCheckoutStatus(c.env, anterior.id).catch(() => null);
    if (status === 'ACTIVE') {
      c.header('Cache-Control', 'no-store');
      return c.json({
        ok: true,
        data: { method: 'card', checkout_url: anterior.url, portal: null, reused: true },
      });
    }
    if (status !== 'CANCELED' && status !== 'EXPIRED') {
      // Paga, ou nao deu para conferir: nunca abrir outra por cima.
      return c.json({ error: 'checkout_in_progress' }, 409);
    }
    // Sessao anterior morreu: segue e cria outra (o tenant antigo, que nunca
    // pagou, sai na faxina de checkouts abandonados).
  }

  // Teto por documento DEPOIS do reuso acima: voltar do Asaas e reabrir a
  // mesma sessao nao cria nada e nao pode esgotar as tentativas do cliente.
  // Tudo o que cria cliente/cobranca continua contado. Chaves de KV nunca
  // carregam dado pessoal em claro: sempre o hash.
  const docHash = await hashApiKey(documento);
  const porDoc = await bumpAttempts(kv, attemptKey('checkout-doc', docHash));
  if (porDoc > MAX_ATTEMPTS_PER_DOC) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  await kv.put(lockKey, '1', { expirationTtl: LOCK_TTL_SECONDS });
  const liberarLock = () => kv.delete(lockKey).catch(() => {});

  const price = Number(c.env.PLAN_PRICE_BRL ?? DEFAULT_PRICE_BRL);
  if (!Number.isFinite(price) || price <= 0) {
    await liberarLock();
    return c.json({ error: 'internal_error' }, 500);
  }

  // Camada 6: nao vender seat que a conta-mestra nao tem. Conta quem ja tem
  // conta (ativa, pausada ou desconectada) E quem pagou e ainda vai conectar
  // (F2.21): senao o sold_out apareceria so depois do pagamento.
  const seatCap = Number(c.env.SEAT_CAP ?? DEFAULT_SEAT_CAP);
  try {
    const ocupados = await seatsInUse(c.env, {
      pendentesDesde: new Date(Date.now() - PIX_VALIDADE_MS).toISOString(),
    });
    if (Number.isFinite(seatCap) && ocupados >= seatCap) {
      console.error('checkout_sold_out');
      await liberarLock();
      return c.json({ error: 'sold_out' }, 503);
    }
  } catch {
    console.error('checkout_capacity_check_failed');
    await liberarLock();
    return c.json({ error: 'internal_error' }, 500);
  }

  // Passo 1 (so Pix): cliente no Asaas. NAO gera cobranca, entao e o lugar
  // certo para descobrir documento/e-mail recusados sem sujar o banco.
  //
  // No CARTAO quem cria o cliente e a pagina hospedada do Asaas: o checkout
  // deles NAO aceita cliente pre-criado (o campo `customer` e recusado mesmo
  // com id existente, confirmado no real em 2026-09-10). A ancora do cartao
  // passa a ser o id da sessao (asaas_checkout_id), nunca o cliente.
  let customerId: string | null = null;
  if (metodo === 'pix_automatic') {
    try {
      customerId = await createCustomer(c.env, {
        name: name.trim(),
        email: emailNorm,
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
  }

  // Passo 2: tenant.
  let tenantId: string;
  try {
    const rows = await supabaseInsert<TenantRow>(c.env, 'tenants', {
      name: name.trim(),
      status: 'active',
      contact_email: emailNorm,
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

  // CARTAO (F2.25): checkout hospedado do Asaas. O cartao e digitado LA; aqui
  // so criamos a sessao (nada e cobrado ate o pagador concluir) e devolvemos
  // a URL para o navegador ir ate ela.
  if (metodo === 'card') {
    const painel = portalUrl(c.env);
    if (!painel) {
      await supabaseDelete(c.env, 'tenants', { id: `eq.${tenantId}` }).catch(() => {});
      await liberarLock();
      return c.json({ error: 'billing_unavailable' }, 502);
    }
    const site = new URL(painel).origin;
    let sessao: { checkoutId: string; url: string };
    try {
      sessao = await createCardCheckout(c.env, {
        value: price,
        description: DESCRICAO_PLANO,
        externalReference: tenantId,
        successUrl: `${painel}?pagamento=cartao`,
        cancelUrl: `${site}/#assinar`,
        expiredUrl: `${site}/#assinar`,
      });
    } catch (err) {
      await supabaseDelete(c.env, 'tenants', { id: `eq.${tenantId}` }).catch(() => {
        console.error(`checkout_orphan_tenant: ${tenantId}`);
      });
      console.error(
        `checkout_card_session_failed: ${err instanceof Error ? err.name : 'erro'}`,
      );
      await liberarLock();
      return c.json({ error: 'billing_unavailable' }, 502);
    }

    try {
      await supabaseInsert(c.env, 'billing_subscriptions', {
        tenant_id: tenantId,
        // Preenchido pelo webhook no 1o pagamento (o Asaas cria o cliente).
        asaas_customer_id: null,
        asaas_checkout_id: sessao.checkoutId,
        payment_method: 'card',
        status: 'pending',
        updated_at: new Date().toISOString(),
      });
    } catch {
      // Sem vinculo a cobranca seria irrecuperavel pelo webhook: cancela a
      // sessao antes que alguem pague (o id nao e segredo; e o fio para
      // reconciliar a mao se o cancelamento tambem falhar).
      const cancelada = await cancelCardCheckout(c.env, sessao.checkoutId).catch(() => false);
      console.error(`checkout_orphan_card_session: ${sessao.checkoutId} cancelada=${cancelada}`);
      await liberarLock();
      return c.json({ error: 'billing_unavailable' }, 502);
    }

    // O lock passa a guardar a sessao (id|url, nada secreto) pela vida dela:
    // uma nova tentativa com os mesmos dados reusa esta em vez de criar outra.
    await kv.put(lockKey, `card:${sessao.checkoutId}|${sessao.url}`, {
      expirationTtl: CARD_LOCK_TTL_SECONDS,
    });

    const portalCartao = await criarSessaoDoComprador(c.env, tenantId);
    c.header('Cache-Control', 'no-store');
    return c.json({
      ok: true,
      data: { value: price, method: 'card', checkout_url: sessao.url, portal: portalCartao },
    });
  }

  if (!customerId) {
    // Nao acontece (o Pix sempre cria o cliente no passo 1); guarda de tipo.
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
      description: DESCRICAO_PLANO,
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

  // Passo 5 (F2.20): token do painel do comprador. A tela do checkout usa para
  // acompanhar o pagamento e abrir o painel (conectar LinkedIn, gerar chave).
  // Falha aqui NAO desfaz a venda: a cobranca ja esta vinculada e o link do
  // painel tambem sai no e-mail de boas-vindas (ou pelo portal:link).
  const portal = await criarSessaoDoComprador(c.env, tenantId);

  // Resposta carrega credencial (token do painel): nunca cachear.
  c.header('Cache-Control', 'no-store');
  return c.json({
    ok: true,
    data: { value: price, method: 'pix_automatic', pix: qr, portal },
  });
});
