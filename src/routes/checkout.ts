import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { supabaseSelect, supabaseInsert, supabaseDelete } from '../lib/supabase';
import { attemptKey, bumpAttempts } from '../lib/throttle';
import { hashApiKey } from '../lib/hash';
import { apenasDigitos, documentoValido } from '../lib/documento';
import {
  createCustomer,
  createSubscription,
  createCardSubscription,
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
// Card testing e rajada de RECUSAS. Cliente legitimo erra o cartao uma ou duas
// vezes; na terceira, o IP para de tentar hoje.
const MAX_DECLINES_PER_IP = 3;
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

interface CartaoValidado {
  card: {
    holderName: string;
    number: string;
    expiryMonth: string;
    expiryYear: string;
    ccv: string;
  };
  holder: { postalCode: string; addressNumber: string; phone: string };
}

// Luhn: barra digitacao errada e lixo de card testing antes de queimar uma
// transacao real na adquirente.
function luhnValido(numero: string): boolean {
  let soma = 0;
  let dobra = false;
  for (let i = numero.length - 1; i >= 0; i--) {
    let d = Number(numero[i]);
    if (dobra) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    soma += d;
    dobra = !dobra;
  }
  return soma % 10 === 0;
}

// Valida a forma dos dados de cartao ANTES de qualquer chamada. Devolve o
// codigo de erro (string) quando invalido. NUNCA loga o conteudo.
function validarCartao(card: unknown, holder: unknown): CartaoValidado | string {
  const c = (card ?? {}) as Record<string, unknown>;
  const h = (holder ?? {}) as Record<string, unknown>;
  const texto = (v: unknown, max: number): string | null =>
    typeof v === 'string' && v.trim().length > 0 && v.length <= max
      ? v.trim()
      : null;
  // Teto de tamanho ANTES do replace: nao rodar regex em string arbitraria.
  const digitosDe = (v: unknown, maxBruto: number): string =>
    typeof v === 'string' && v.length <= maxBruto ? v.replace(/\D/g, '') : '';
  // Mes/ano aceitam numero tambem (armadilha comum de integracao).
  const comoTexto = (v: unknown): string =>
    typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

  const holderName = texto(c.holder_name, 100);
  const numero = digitosDe(c.number, 32);
  const mes = comoTexto(c.expiry_month).trim().padStart(2, '0');
  const ano = comoTexto(c.expiry_year).trim();
  const ccv = digitosDe(c.ccv, 8);

  if (!holderName) return 'invalid_card_holder';
  if (numero.length < 13 || numero.length > 19) return 'invalid_card_number';
  if (!luhnValido(numero)) return 'invalid_card_number';
  if (!/^(0[1-9]|1[0-2])$/.test(mes)) return 'invalid_card_expiry';
  if (!/^\d{4}$/.test(ano)) return 'invalid_card_expiry';
  // Validade tem que estar no futuro e dentro de um horizonte plausivel.
  const agora = new Date();
  const anoAtual = agora.getUTCFullYear();
  const mesAtual = agora.getUTCMonth() + 1;
  const anoNum = Number(ano);
  if (anoNum < anoAtual || anoNum > anoAtual + 20) return 'invalid_card_expiry';
  if (anoNum === anoAtual && Number(mes) < mesAtual) return 'invalid_card_expiry';
  if (ccv.length < 3 || ccv.length > 4) return 'invalid_card_ccv';

  const cep = digitosDe(h.postal_code, 20);
  const numeroEndereco = texto(h.address_number, 10);
  const telefone = digitosDe(h.phone, 25);
  if (cep.length !== 8) return 'invalid_postal_code';
  if (!numeroEndereco) return 'invalid_address_number';
  if (telefone.length < 10 || telefone.length > 11) return 'invalid_phone';

  return {
    card: { holderName, number: numero, expiryMonth: mes, expiryYear: ano, ccv },
    holder: { postalCode: cep, addressNumber: numeroEndereco, phone: telefone },
  };
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

  // O IP e checado e retorna ANTES de tocar o contador global. Ao contrario,
  // um unico IP abusivo consumiria o teto global e derrubaria as vendas do dia
  // inteiro (auto-DoS).
  const ipHeader = c.req.header('CF-Connecting-IP');
  const ip = ipHeader ?? 'unknown';
  const porIp = await bumpAttempts(kv, attemptKey('checkout-ip', ip));
  if (porIp > MAX_ATTEMPTS_PER_IP) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  // Recusas anteriores deste IP: card testing se manifesta como rajada de
  // recusas, e o teto por documento nao pega (CPF valido se gera aos milhares).
  const recusas = Number(
    (await kv.get(attemptKey('checkout-declines', ip))) ?? '0',
  );
  if (recusas >= MAX_DECLINES_PER_IP) {
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

  const { name, email, cpf_cnpj, payment_method, card, holder } = (body ??
    {}) as Record<string, unknown>;

  const metodo = payment_method === 'card' ? 'card' : 'pix';

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

  // Campos extras do cartao. O Asaas exige titular completo (antifraude).
  // IMPORTANT: nada daqui e logado ou gravado; segue direto para o Asaas.
  let dadosCartao: CartaoValidado | null = null;
  if (metodo === 'card') {
    const validado = validarCartao(card, holder);
    if (typeof validado === 'string') {
      return c.json({ error: validado }, 400);
    }
    dadosCartao = validado;
  }

  // Chaves de KV nunca carregam dado pessoal em claro: sempre o hash.
  const docHash = await hashApiKey(documento);
  const porDoc = await bumpAttempts(kv, attemptKey('checkout-doc', docHash));
  if (porDoc > MAX_ATTEMPTS_PER_DOC) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  // Camada 5: lock de idempotencia (duplo clique / reenvio do formulario).
  // Toda saida de FALHA libera o lock: senao um cartao recusado prenderia o
  // cliente por 15 minutos, justamente quando ele quer tentar outro cartao.
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
      await liberarLock();
      return c.json({ error: 'sold_out' }, 503);
    }
  } catch {
    console.error('checkout_capacity_check_failed');
    await liberarLock();
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
      await liberarLock();
      return c.json({ error: 'invalid_document' }, 400);
    }
    console.error(`checkout_customer_failed: ${message}`);
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

  // Passo 3: assinatura. A partir daqui existe cobranca real.
  // Cartao: o Asaas valida e JA CAPTURA o primeiro ciclo, depois debita sozinho.
  // Pix: o Asaas emite uma cobranca por ciclo e o cliente paga cada uma.
  let subscriptionId: string;
  let cartaoResumo: { last_digits: string; brand: string } | null = null;
  try {
    if (dadosCartao) {
      const resultado = await createCardSubscription(c.env, {
        customerId,
        value: price,
        description: 'LinkedAPI, 1 conta de LinkedIn conectada',
        externalReference: tenantId,
        // Só o IP REAL do pagador vai ao antifraude. Sem header, o campo é
        // omitido: mandar 'unknown' desligaria o antifraude em silêncio.
        remoteIp: ipHeader ?? null,
        card: dadosCartao.card,
        holder: {
          name: name.trim(),
          email,
          cpfCnpj: documento,
          ...dadosCartao.holder,
        },
      });
      subscriptionId = resultado.subscriptionId;
      cartaoResumo = { last_digits: resultado.lastDigits, brand: resultado.brand };
    } else {
      subscriptionId = await createSubscription(c.env, {
        customerId,
        value: price,
        description: 'LinkedAPI, 1 conta de LinkedIn conectada',
        externalReference: tenantId,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    // Cartao recusado pela adquirente e erro DO CLIENTE, nao nosso: 402 para
    // ele poder tentar outro cartao. Sem detalhe do upstream.
    if (message.startsWith('asaas_card_failed:400')) {
      // Recusa conta para o teto de card testing daquele IP.
      await bumpAttempts(kv, attemptKey('checkout-declines', ip));
      // O tenant acabou de nascer e nao chegou a valer (sem chave, sem conta,
      // sem cobranca). Recusa de cartao e comum: sem isso o banco acumularia
      // um tenant morto por digitacao errada.
      await supabaseDelete(c.env, 'tenants', { id: `eq.${tenantId}` }).catch(() => {
        console.error('checkout_orphan_tenant');
      });
      // Libera o lock: o cliente precisa poder tentar outro cartao agora.
      await liberarLock();
      return c.json({ error: 'card_declined' }, 402);
    }
    // Falha nao-determinada no cartao (ex.: timeout): o dinheiro PODE ter saido.
    // O tenantId e o externalReference enviado ao Asaas, entao e o unico fio
    // para reconciliar a mao. Nao e segredo.
    console.error(
      `checkout_subscription_failed: ${err instanceof Error ? err.name : 'erro'} tenant=${tenantId} metodo=${metodo}`,
    );
    await liberarLock();
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
    await liberarLock();
    return c.json({ error: 'billing_unavailable' }, 502);
  }

  // Cartao: ja foi capturado na criacao da assinatura, nao ha QR a mostrar.
  if (cartaoResumo) {
    return c.json({
      ok: true,
      data: { value: price, method: 'card', card: cartaoResumo },
    });
  }

  // Passo 5 (Pix): QR da primeira cobranca. Se nao vier, a assinatura existe e o
  // cliente recebe a cobranca de outras formas: respondemos ok sem QR.
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

  return c.json({ ok: true, data: { value: price, method: 'pix', pix } });
});
