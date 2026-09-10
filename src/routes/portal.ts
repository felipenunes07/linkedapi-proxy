import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { supabaseSelect, supabaseInsert, supabaseUpdate } from '../lib/supabase';
import { hashApiKey } from '../lib/hash';
import { randomHex32 } from '../lib/random';
import { attemptKey, bumpAttempts } from '../lib/throttle';
import { fireAndForget } from '../lib/async';
import { emailValido } from '../lib/documento';
import { emailConfigured } from '../lib/email';
import { updateCustomerEmail } from '../lib/asaas';
import { isValidWebhookUrl } from './selfservice';
import {
  resolvePortalToken,
  exchangeLinkToken,
  createConnectLink,
  enviarLinkDeAcesso,
  seatsInUse,
  type PortalSession,
} from '../lib/portal';

// Painel do cliente (F2.20/F2.21): o que o dashboard de uma API self-service
// faz. O cliente paga no checkout e, sem operador no meio, conecta o LinkedIn
// e gera a propria chave de API.
//
//   GET  /portal/status   assinatura, LinkedIn, chave e uso de hoje
//   POST /portal/connect  link do wizard para conectar (ou reconectar) o LinkedIn
//   POST /portal/key      gera a chave de API (mostrada UMA vez) e revoga as anteriores
//   PUT  /portal/email    corrige o e-mail de contato (so antes do 1o pagamento)
//   POST /portal/logout   revoga a sessao usada, ou todas ({ "all": true })
//   POST /portal/session  troca um link do e-mail (uso unico) por uma sessao
//   POST /portal/login    manda por e-mail um link novo de acesso
//
// Autenticacao: header X-PORTAL-TOKEN com a SESSAO (lk_portal_). O token
// decide o tenant; NENHUM id vem do request (mesma regra do account_id no
// proxy). CORS restrito a landing (src/index.ts); o header proprio forca
// preflight em chamada cross-site.
//
// Camadas (fail-closed, na ordem): KV obrigatorio -> teto por IP -> teto de
// tokens invalidos por IP (antes de tocar o banco) -> token -> regra de
// negocio -> teto por tenant nas acoes que custam (link, chave).

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

// /status faz polling enquanto espera o Pix (10s, com teto de tempo) e um IP
// de operadora movel (CGNAT) pode ser dividido por varios clientes: folgado de
// proposito. A defesa contra enumeracao e o teto de tokens INEXISTENTES abaixo.
const MAX_REQUESTS_PER_IP = 2000;
const MAX_BAD_TOKENS_PER_IP = 30;
const MAX_CONNECT_LINKS_PER_TENANT = 10;
const MAX_KEYS_PER_TENANT = 5;
const MAX_LOGIN_PER_IP = 10;
const MAX_LOGIN_PER_EMAIL = 3;
const MAX_SESSION_PER_IP = 30;
const MAX_TOKEN_LENGTH = 200;
const MAX_EMAIL = 150;
const DEFAULT_SEAT_CAP = 10;
const KEY_LOCK_TTL_SECONDS = 60;
const MAX_WEBHOOK_CHANGES_PER_TENANT = 20;
const LINK_TOKEN_FORMAT = /^lk_plink_[0-9a-f]{64}$/;

interface AccountRow {
  unipile_account_id: string;
  status: string;
}

interface BillingRow {
  status: string;
}

interface IdRow {
  id: string;
}

interface UsageRow {
  action: string;
  count: number;
}

type LinkedinState =
  | { state: 'none' | 'active' | 'paused' }
  | { state: 'disconnected'; accountId: string };

// Estado do LinkedIn do tenant a partir das linhas (mais recente primeiro).
// 1 seat = 1 conta: ativa vence; pausa (billing) vem antes de desconexao.
function linkedinState(rows: AccountRow[]): LinkedinState {
  if (rows.some((r) => r.status === 'active')) return { state: 'active' };
  if (rows.some((r) => r.status === 'paused')) return { state: 'paused' };
  const recente = rows.find((r) => r.status === 'disconnected');
  if (recente) return { state: 'disconnected', accountId: recente.unipile_account_id };
  return { state: 'none' };
}

async function subscriptionStatus(env: Env, tenantId: string): Promise<string> {
  const rows = await supabaseSelect<BillingRow>(env, 'billing_subscriptions', {
    tenant_id: `eq.${tenantId}`,
    select: 'status',
    limit: '1',
  });
  return rows[0]?.status ?? 'none';
}

function tenantAccounts(env: Env, tenantId: string): Promise<AccountRow[]> {
  return supabaseSelect<AccountRow>(env, 'connected_accounts', {
    tenant_id: `eq.${tenantId}`,
    provider: 'eq.linkedin',
    select: 'unipile_account_id,status',
    order: 'created_at.desc',
  });
}

function jsonExigido(c: Ctx): Response | null {
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return c.json({ error: 'invalid_content_type' }, 415);
  }
  return null;
}

async function lerCorpo(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return (body ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function gate(c: Ctx): Promise<PortalSession | Response> {
  const kv = c.env.RATE_LIMIT;
  if (!kv) {
    return c.json({ error: 'rate_limit_unavailable' }, 500);
  }
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  if ((await bumpAttempts(kv, attemptKey('portal-ip', ip))) > MAX_REQUESTS_PER_IP) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const token = c.req.header('X-PORTAL-TOKEN');
  if (!token) {
    return c.json({ error: 'missing_portal_token' }, 401);
  }

  // Quem ja errou demais hoje nem chega ao banco (enumeracao de token).
  const badKey = attemptKey('portal-bad-ip', ip);
  if (Number((await kv.get(badKey)) ?? '0') >= MAX_BAD_TOKENS_PER_IP) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const check =
    token.length <= MAX_TOKEN_LENGTH
      ? await resolvePortalToken(c.env, token)
      : ({ motivo: 'inexistente' } as const);
  if ('motivo' in check) {
    // So token que NUNCA existiu conta como tentativa ruim (enumeracao).
    // Sessao vencida ou revogada e cliente legitimo com dado velho, e punir
    // isso bloqueava o proprio IP dele (review F2.21, 2a passada).
    if (check.motivo === 'inexistente') await bumpAttempts(kv, badKey);
    return c.json({ error: 'invalid_portal_token' }, 401);
  }

  // Toda resposta autenticada do painel e dado da conta: nunca cachear.
  c.header('Cache-Control', 'no-store');
  return check.session;
}

export const portal = new Hono<{ Bindings: Env; Variables: Variables }>();

portal.get('/status', async (c) => {
  const s = await gate(c);
  if (s instanceof Response) return s;

  const hoje = new Date().toISOString().slice(0, 10);
  const [assinatura, contas, chaves, uso] = await Promise.all([
    subscriptionStatus(c.env, s.tenantId),
    tenantAccounts(c.env, s.tenantId),
    supabaseSelect<IdRow>(c.env, 'api_keys', {
      tenant_id: `eq.${s.tenantId}`,
      status: 'eq.active',
      select: 'id',
    }),
    supabaseSelect<UsageRow>(c.env, 'usage_daily', {
      tenant_id: `eq.${s.tenantId}`,
      day: `eq.${hoje}`,
      select: 'action,count',
    }),
  ]);
  const usado = (acao: string) => uso.find((u) => u.action === acao)?.count ?? 0;

  // Whitelist: nada de tenant_id, account_id nem ids de cobranca. O e-mail e
  // o do PROPRIO dono da sessao (para ele conferir para onde vao os avisos).
  return c.json({
    ok: true,
    data: {
      name: s.tenantName,
      email: s.contactEmail,
      subscription: assinatura,
      linkedin: linkedinState(contas).state,
      has_key: chaves.length > 0,
      limits: s.limits,
      usage_today: { messages: usado('messages'), invitations: usado('invitations') },
      docs_url: `${new URL(c.req.url).origin}/docs`,
      email_login: emailConfigured(c.env),
    },
  });
});

portal.post('/connect', async (c) => {
  const s = await gate(c);
  if (s instanceof Response) return s;

  if ((await subscriptionStatus(c.env, s.tenantId)) !== 'active') {
    return c.json({ error: 'payment_required' }, 402);
  }
  const linkedin = linkedinState(await tenantAccounts(c.env, s.tenantId));
  if (linkedin.state === 'active') {
    return c.json({ error: 'already_connected' }, 409);
  }
  if (linkedin.state === 'paused') {
    return c.json({ error: 'payment_required' }, 402);
  }

  const tentativas = await bumpAttempts(
    c.env.RATE_LIMIT,
    attemptKey('portal-connect', s.tenantId),
  );
  if (tentativas > MAX_CONNECT_LINKS_PER_TENANT) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  if (linkedin.state === 'none') {
    // Conta nova ocupa seat da conta-mestra. O proprio tenant (assinatura
    // ativa) ja entra na contagem, entao so estoura se PASSAR do teto.
    const seatCap = Number(c.env.SEAT_CAP ?? DEFAULT_SEAT_CAP);
    if (Number.isFinite(seatCap) && (await seatsInUse(c.env)) > seatCap) {
      console.error('portal_connect_sold_out');
      return c.json({ error: 'sold_out' }, 503);
    }
  }

  const link =
    linkedin.state === 'disconnected'
      ? await createConnectLink(c.env, s.tenantId, 'reconnect', linkedin.accountId, {
          voltarAoPainel: true,
        })
      : await createConnectLink(c.env, s.tenantId, 'create', undefined, {
          voltarAoPainel: true,
        });
  if (!link) {
    console.error('portal_connect_link_failed');
    return c.json({ error: 'connect_unavailable' }, 503);
  }
  return c.json({
    ok: true,
    data: {
      url: link.url,
      expires_at: link.expiresAt,
      reconnect: linkedin.state === 'disconnected',
    },
  });
});

portal.post('/key', async (c) => {
  const s = await gate(c);
  if (s instanceof Response) return s;

  if ((await subscriptionStatus(c.env, s.tenantId)) !== 'active') {
    return c.json({ error: 'payment_required' }, 402);
  }
  // Chave sem conta conectada nao autentica (resolveTenant exige a conta):
  // entregar uma agora so geraria 401 e ticket de suporte.
  const linkedin = linkedinState(await tenantAccounts(c.env, s.tenantId));
  if (linkedin.state !== 'active') {
    return c.json({ error: 'linkedin_not_connected' }, 409);
  }

  const kv = c.env.RATE_LIMIT;
  // Duas abas (ou retry) gerando ao mesmo tempo revogariam a chave uma da
  // outra e o tenant ficaria sem nenhuma (review M2).
  const lockKey = `portal:key:lock:${s.tenantId}`;
  if (await kv.get(lockKey)) {
    return c.json({ error: 'key_in_progress' }, 409);
  }
  const tentativas = await bumpAttempts(kv, attemptKey('portal-key', s.tenantId));
  if (tentativas > MAX_KEYS_PER_TENANT) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  await kv.put(lockKey, '1', { expirationTtl: KEY_LOCK_TTL_SECONDS });

  try {
    const apiKey = `lk_live_${randomHex32()}`;
    const keyHash = await hashApiKey(apiKey);

    // Ordem igual a da rotacao: cria a nova ANTES de revogar as antigas, para
    // o tenant nunca ficar sem chave se algo falhar no meio.
    const criadas = await supabaseInsert<{ created_at?: string }>(c.env, 'api_keys', {
      tenant_id: s.tenantId,
      key_hash: keyHash,
      status: 'active',
    });
    // Revoga as ANTERIORES a esta pela data de criacao (F2.23): o lock KV
    // acima nao e exclusao mutua, e com "diferente desta" duas geracoes
    // simultaneas revogariam uma a outra e o tenant ficaria sem chave. Pela
    // data, a mais nova sempre sobrevive.
    const criadaEm = criadas[0]?.created_at;
    await supabaseUpdate(
      c.env,
      'api_keys',
      criadaEm
        ? {
            tenant_id: `eq.${s.tenantId}`,
            status: 'eq.active',
            created_at: `lt.${criadaEm}`,
          }
        : {
            tenant_id: `eq.${s.tenantId}`,
            status: 'eq.active',
            key_hash: `neq.${keyHash}`,
          },
      { status: 'revoked' },
    );

    return c.json({
      ok: true,
      data: {
        api_key: apiKey,
        note: 'Guarde agora: este valor nao sera exibido de novo. Chaves anteriores desta conta foram revogadas.',
      },
    });
  } finally {
    await kv.delete(lockKey).catch(() => {});
  }
});

// Webhook do cliente pelo painel (F2.26): o mesmo que PUT/GET/DELETE
// /v1/webhook, para quem prefere configurar pela tela, como no dashboard da
// Unipile. Mesma validacao anti-SSRF (so https:443, sem IP literal nem nome
// interno); o secret de assinatura aparece UMA vez e nunca e reexibido.
portal.get('/webhook', async (c) => {
  const s = await gate(c);
  if (s instanceof Response) return s;
  const rows = await supabaseSelect<{ webhook_url?: string | null }>(c.env, 'tenants', {
    id: `eq.${s.tenantId}`,
    select: 'webhook_url',
    limit: '1',
  });
  const url = rows[0]?.webhook_url ?? null;
  return c.json({ ok: true, data: { url, configured: url !== null } });
});

portal.put('/webhook', async (c) => {
  const s = await gate(c);
  if (s instanceof Response) return s;
  const body = await lerCorpo(c);
  const url = body?.url;
  if (typeof url !== 'string' || !isValidWebhookUrl(url)) {
    return c.json({ error: 'invalid_url' }, 400);
  }
  const trocas = await bumpAttempts(c.env.RATE_LIMIT, attemptKey('portal-webhook', s.tenantId));
  if (trocas > MAX_WEBHOOK_CHANGES_PER_TENANT) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const secret = `lk_whsec_${randomHex32()}`;
  await supabaseUpdate(
    c.env,
    'tenants',
    { id: `eq.${s.tenantId}` },
    { webhook_url: url, webhook_secret: secret },
  );
  return c.json({
    ok: true,
    data: {
      url,
      secret,
      note: 'Guarde o secret agora: ele assina cada evento (X-Webhook-Signature) e nao sera exibido de novo.',
    },
  });
});

portal.delete('/webhook', async (c) => {
  const s = await gate(c);
  if (s instanceof Response) return s;
  await supabaseUpdate(
    c.env,
    'tenants',
    { id: `eq.${s.tenantId}` },
    { webhook_url: null, webhook_secret: null },
  );
  return c.json({ ok: true, data: { configured: false } });
});

// Correcao do e-mail de contato (review I2): um erro de digitacao no checkout
// mandaria as boas-vindas (e o acesso) para um terceiro. So ANTES do primeiro
// pagamento: depois dele, o e-mail vira canal de acesso e trocar pede o
// operador (senao uma sessao vazada viraria acesso permanente).
portal.put('/email', async (c) => {
  const s = await gate(c);
  if (s instanceof Response) return s;

  const body = await lerCorpo(c);
  const email = body?.email;
  if (typeof email !== 'string' || email.length > MAX_EMAIL || !emailValido(email.trim())) {
    return c.json({ error: 'invalid_email' }, 400);
  }
  const subs = await supabaseSelect<BillingRow & { asaas_customer_id?: string | null }>(
    c.env,
    'billing_subscriptions',
    { tenant_id: `eq.${s.tenantId}`, select: 'status,asaas_customer_id', limit: '1' },
  );
  const sub = subs[0];
  if (!sub || sub.status !== 'pending') {
    return c.json({ error: 'email_locked' }, 409);
  }
  const normalizado = email.trim().toLowerCase();
  // O Asaas tambem precisa do e-mail certo: e para la que vao as faturas quando
  // as notificacoes forem ligadas no 1o pagamento (F2.23). Se o Asaas falhar,
  // nada muda aqui (senao os dois lados ficariam divergentes).
  if (sub.asaas_customer_id && c.env.ASAAS_API_KEY) {
    const ok = await updateCustomerEmail(c.env, sub.asaas_customer_id, normalizado).catch(
      () => false,
    );
    if (!ok) {
      console.error('portal_email_asaas_failed');
      return c.json({ error: 'billing_unavailable' }, 502);
    }
  }
  await supabaseUpdate(
    c.env,
    'tenants',
    { id: `eq.${s.tenantId}`, status: 'eq.active' },
    { contact_email: normalizado },
  );
  return c.json({ ok: true, data: { email: normalizado } });
});

// Sair: revoga a sessao usada. Com { "all": true }, revoga TODAS as
// credenciais do painel deste tenant (sessoes e links ainda nao usados): e o
// botao de panico se um link ou sessao vazou (review I1).
portal.post('/logout', async (c) => {
  const s = await gate(c);
  if (s instanceof Response) return s;

  const body = await lerCorpo(c);
  const todas = body?.all === true;
  await supabaseUpdate(
    c.env,
    'portal_tokens',
    todas
      ? { tenant_id: `eq.${s.tenantId}`, status: 'eq.active' }
      : { token_hash: `eq.${s.tokenHash}`, tenant_id: `eq.${s.tenantId}` },
    { status: 'revoked' },
  );
  return c.json({ ok: true, data: { all: todas } });
});

// Troca de link (e-mail) por sessao. Publica, sem X-PORTAL-TOKEN: a prova e o
// proprio link de uso unico. Mesmo teto de tokens invalidos do gate.
portal.post('/session', async (c) => {
  const kv = c.env.RATE_LIMIT;
  if (!kv) {
    return c.json({ error: 'rate_limit_unavailable' }, 500);
  }
  const semJson = jsonExigido(c);
  if (semJson) return semJson;

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  if ((await bumpAttempts(kv, attemptKey('portal-session-ip', ip))) > MAX_SESSION_PER_IP) {
    return c.json({ error: 'rate_limited' }, 429);
  }
  const badKey = attemptKey('portal-bad-ip', ip);
  if (Number((await kv.get(badKey)) ?? '0') >= MAX_BAD_TOKENS_PER_IP) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const body = await lerCorpo(c);
  const token = body?.token;
  const troca =
    typeof token === 'string' && LINK_TOKEN_FORMAT.test(token)
      ? await exchangeLinkToken(c.env, token)
      : ({ motivo: 'inexistente' } as const);
  if ('motivo' in troca) {
    // Link usado ou vencido nao pune o IP (o cliente so clicou de novo).
    if (troca.motivo === 'inexistente') await bumpAttempts(kv, badKey);
    return c.json({ error: 'invalid_link' }, 401);
  }

  c.header('Cache-Control', 'no-store');
  return c.json({ ok: true, data: { token: troca.token, expires_at: troca.expiresAt } });
});

// "Entrar no painel": rota publica sem token. Resposta IGUAL exista ou nao
// conta com o e-mail (sem oraculo), e a busca + envio rodam depois da resposta
// para o tempo de resposta tambem nao denunciar.
portal.post('/login', async (c) => {
  const kv = c.env.RATE_LIMIT;
  if (!kv) {
    return c.json({ error: 'rate_limit_unavailable' }, 500);
  }
  // Sem application/json um form cross-site viraria "simple request".
  const semJson = jsonExigido(c);
  if (semJson) return semJson;

  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  if ((await bumpAttempts(kv, attemptKey('portal-login-ip', ip))) > MAX_LOGIN_PER_IP) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  const body = await lerCorpo(c);
  if (!body) {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const { email } = body;
  if (typeof email !== 'string' || email.length > MAX_EMAIL || !emailValido(email.trim())) {
    return c.json({ error: 'invalid_email' }, 400);
  }
  if (!emailConfigured(c.env)) {
    return c.json({ error: 'email_unavailable' }, 503);
  }

  const normalizado = email.trim().toLowerCase();
  // Teto por e-mail (hash; KV nunca guarda dado pessoal em claro): ninguem
  // usa esta rota para lotar a caixa de um terceiro.
  const porEmail = await bumpAttempts(
    kv,
    attemptKey('portal-login-email', await hashApiKey(normalizado)),
  );
  if (porEmail <= MAX_LOGIN_PER_EMAIL) {
    fireAndForget(c, () => enviarLinkDeAcesso(c.env, normalizado));
  }
  return c.json({ ok: true });
});
