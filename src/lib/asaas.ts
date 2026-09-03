import type { Env } from '../types';

// Cliente minimo do Asaas para o checkout proprio (F2.14).
//
// A chave (ASAAS_API_KEY) e segredo de conta financeira: mesma disciplina do
// master token da Unipile, nunca sai do servidor, nunca aparece em log nem em
// resposta. Erros viram codigo sem corpo cru (o corpo do Asaas pode carregar
// detalhe da conta); so a DESCRICAO de validacao (mensagem de campo, do tipo
// "CPF invalido") e logada, porque e o que o operador precisa para diagnosticar.

const DEFAULT_BASE = 'https://api.asaas.com/v3';

// O Asaas RECUSA requisicao sem User-Agent (erro user_agent_not_informed) e o
// fetch do Workers nao manda um por padrao. Confirmado no real em 2026-09-03.
const USER_AGENT = 'LinkedAPI/1.0';

// Timeout curto: o checkout e sincrono e o cliente esta esperando.
const TIMEOUT_MS = 10_000;

export interface AsaasPixQrCode {
  encodedImage?: string;
  payload?: string;
  expirationDate?: string;
}

// Base configuravel para que `npm run dev` possa apontar ao sandbox. Sem o
// override, dev local bateria em PRODUCAO e criaria cobranca real.
function baseUrl(env: Env): string {
  return (env.ASAAS_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
}

async function asaasFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const apiKey = env.ASAAS_API_KEY;
  if (!apiKey) {
    // Fail-closed: sem chave, o checkout nao existe (a rota responde 404).
    throw new Error('asaas_not_configured');
  }
  try {
    return await fetch(`${baseUrl(env)}${path}`, {
      ...init,
      headers: {
        access_token: apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Nunca deixar erro de runtime carregar a URL/credencial para o log.
    throw new Error('asaas_unreachable');
  }
}

// Corpo de sucesso, sem deixar o SyntaxError do parse carregar trecho do JSON
// (que contem nome/e-mail/CPF do cliente) para o log.
async function readJson<T>(res: Response, code: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`${code}:parse`);
  }
}

// Remove sequencias longas de digitos de qualquer texto vindo do upstream.
// Defesa em profundidade: nunca dependemos da promessa de que o Asaas nao ecoa
// um PAN dentro de uma mensagem de validacao.
function semDigitosLongos(texto: string): string {
  return texto.replace(/\d{12,}/g, '[redigido]');
}

// Erro de validacao do Asaas. `code` e um identificador de maquina (seguro);
// `description` e texto livre do upstream, entao so sai higienizado e NUNCA no
// caminho de cartao (ver validationCode).
async function validationDetail(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as {
      errors?: { code?: string; description?: string }[];
    };
    const first = data.errors?.[0];
    if (!first) return 'sem detalhe';
    return semDigitosLongos(`${first.code ?? '?'}: ${first.description ?? '?'}`);
  } catch {
    return 'corpo ilegivel';
  }
}

// So o codigo de maquina. Usado no caminho PCI: em transacao de cartao nao se
// loga texto livre de terceiro, ponto.
async function validationCode(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { errors?: { code?: string }[] };
    return data.errors?.[0]?.code ?? 'sem_codigo';
  } catch {
    return 'corpo_ilegivel';
  }
}

export async function createCustomer(
  env: Env,
  input: {
    name: string;
    email: string;
    cpfCnpj: string;
    externalReference: string;
    // Checkout publico cria cliente com notificacao DESLIGADA: sem isso,
    // qualquer um informa o CPF/e-mail de um terceiro e a NOSSA conta dispara
    // cobranca por e-mail contra essa pessoa (spam com cara de golpe).
    notificationsEnabled: boolean;
  },
): Promise<string> {
  const res = await asaasFetch(env, '/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      email: input.email,
      cpfCnpj: input.cpfCnpj,
      externalReference: input.externalReference,
      notificationDisabled: !input.notificationsEnabled,
    }),
  });
  if (!res.ok) {
    console.error(`asaas_customer_rejected: ${await validationDetail(res)}`);
    throw new Error(`asaas_customer_failed:${res.status}`);
  }
  const data = await readJson<{ id?: string }>(res, 'asaas_customer_failed');
  if (!data.id) {
    throw new Error('asaas_customer_failed:no_id');
  }
  return data.id;
}

export async function createSubscription(
  env: Env,
  input: {
    customerId: string;
    value: number;
    description: string;
    externalReference: string;
  },
): Promise<string> {
  // Primeiro vencimento hoje: o cliente paga o Pix na hora e ja entra ativo.
  const today = new Date().toISOString().slice(0, 10);
  const res = await asaasFetch(env, '/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      customer: input.customerId,
      billingType: 'PIX',
      value: input.value,
      nextDueDate: today,
      cycle: 'MONTHLY',
      description: input.description,
      externalReference: input.externalReference,
    }),
  });
  if (!res.ok) {
    console.error(`asaas_subscription_rejected: ${await validationDetail(res)}`);
    throw new Error(`asaas_subscription_failed:${res.status}`);
  }
  const data = await readJson<{ id?: string }>(res, 'asaas_subscription_failed');
  if (!data.id) {
    throw new Error('asaas_subscription_failed:no_id');
  }
  return data.id;
}

// Liga as notificacoes do Asaas para um cliente que JA PAGOU (F2.16).
//
// O checkout cria o cliente com notificacao desligada de proposito (B2: senao
// qualquer um dispara cobranca por e-mail contra o CPF de um terceiro). Mas a
// assinatura Pix nao debita sozinha: o Asaas emite uma cobranca nova todo mes e
// o cliente precisa ser AVISADO para pagar. Depois do primeiro pagamento ele e
// um cliente verificado, entao ligar a notificacao deixa de ser risco e passa a
// ser necessario para a recorrencia funcionar.
export async function enableCustomerNotifications(
  env: Env,
  customerId: string,
): Promise<boolean> {
  const res = await asaasFetch(env, `/customers/${encodeURIComponent(customerId)}`, {
    method: 'POST',
    body: JSON.stringify({ notificationDisabled: false }),
  });
  return res.ok;
}

// Assinatura no CARTAO: cobranca automatica de verdade (o Asaas valida o cartao
// na criacao e debita sozinho a cada ciclo).
//
// REGRA INVIOLAVEL DESTE CAMINHO: os dados do cartao atravessam o Worker e vao
// direto para o Asaas. NUNCA sao gravados, NUNCA sao logados, NUNCA voltam na
// resposta ao cliente e NUNCA entram em mensagem de erro. O objeto morre no
// fim desta funcao.
export interface CardInput {
  holderName: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  ccv: string;
}

export interface CardHolderInput {
  name: string;
  email: string;
  cpfCnpj: string;
  postalCode: string;
  addressNumber: string;
  phone: string;
}

export interface CardSubscriptionResult {
  subscriptionId: string;
  // So o que e seguro mostrar de volta ao cliente (confirmacao visual).
  lastDigits: string;
  brand: string;
}

export async function createCardSubscription(
  env: Env,
  input: {
    customerId: string;
    value: number;
    description: string;
    externalReference: string;
    // IP do PAGADOR (antifraude do Asaas), nunca o do servidor. null quando
    // desconhecido: mandar um literal invalido desligaria o antifraude em
    // silencio, entao o campo simplesmente nao vai.
    remoteIp: string | null;
    card: CardInput;
    holder: CardHolderInput;
  },
): Promise<CardSubscriptionResult> {
  const today = new Date().toISOString().slice(0, 10);
  const res = await asaasFetch(env, '/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      customer: input.customerId,
      billingType: 'CREDIT_CARD',
      value: input.value,
      nextDueDate: today,
      cycle: 'MONTHLY',
      description: input.description,
      externalReference: input.externalReference,
      ...(input.remoteIp ? { remoteIp: input.remoteIp } : {}),
      creditCard: input.card,
      creditCardHolderInfo: input.holder,
    }),
  });
  if (!res.ok) {
    // Caminho PCI: SO o codigo de maquina. Texto livre do upstream nunca entra
    // no log aqui, nem "limpo": nao se aposta em promessa de terceiro sobre o
    // que ele ecoa numa mensagem de erro.
    console.error(`asaas_card_rejected: ${await validationCode(res)}`);
    throw new Error(`asaas_card_failed:${res.status}`);
  }
  const data = await readJson<{
    id?: string;
    creditCard?: { creditCardNumber?: string; creditCardBrand?: string };
  }>(res, 'asaas_card_failed');
  if (!data.id) {
    throw new Error('asaas_card_failed:no_id');
  }
  // Nao confiar no upstream para o tamanho: truncar e validar antes de deixar
  // sair na resposta.
  const digitos = (data.creditCard?.creditCardNumber ?? '').replace(/\D/g, '');
  const ultimos = digitos.slice(-4);
  const marca = (data.creditCard?.creditCardBrand ?? '').slice(0, 20);
  return {
    subscriptionId: data.id,
    lastDigits: /^\d{4}$/.test(ultimos) ? ultimos : '',
    brand: /^[A-Za-z_ ]*$/.test(marca) ? marca : '',
  };
}

// Desfaz a assinatura quando o vinculo no nosso banco falha: sem isso o cliente
// seria cobrado por uma assinatura que o webhook nunca conseguiria resolver.
export async function cancelSubscription(
  env: Env,
  subscriptionId: string,
): Promise<boolean> {
  const res = await asaasFetch(
    env,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: 'DELETE' },
  );
  return res.ok;
}

// Primeira cobranca da assinatura (a que o cliente paga agora).
export async function firstPaymentId(
  env: Env,
  subscriptionId: string,
): Promise<string | null> {
  const res = await asaasFetch(
    env,
    `/subscriptions/${encodeURIComponent(subscriptionId)}/payments?limit=1`,
  );
  if (!res.ok) {
    return null;
  }
  const data = await readJson<{ data?: { id?: string }[] }>(
    res,
    'asaas_payments_failed',
  );
  return data.data?.[0]?.id ?? null;
}

export async function pixQrCode(
  env: Env,
  paymentId: string,
): Promise<AsaasPixQrCode | null> {
  const res = await asaasFetch(
    env,
    `/payments/${encodeURIComponent(paymentId)}/pixQrCode`,
  );
  if (!res.ok) {
    return null;
  }
  return await readJson<AsaasPixQrCode>(res, 'asaas_pix_failed');
}
