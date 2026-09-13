import type { Env, RateLimitAction } from '../types';
import {
  supabaseInsert,
  supabaseSelect,
  supabaseUpdate,
  supabaseRpcSelect,
} from './supabase';
import { hashApiKey } from './hash';
import { randomHex32 } from './random';
import { createHostedAuthLink } from './unipile';
import { emailConfigured, sendEmail } from './email';
import { DAILY_LIMITS } from './limits';

// Painel do cliente (F2.20): credenciais do painel, link do wizard de conexao,
// contagem de seats e os e-mails de acesso. As rotas moram em
// src/routes/portal.ts.
//
// Dois tipos de credencial, os dois SO com hash no banco (F2.21, review):
//   sessao (lk_portal_<64 hex>): vive so no navegador do cliente. Nasce no
//     checkout ou na troca de um link. Vale 14 dias; revogavel (sair / sair
//     de todos os dispositivos). E com ela que o painel age.
//   link   (lk_plink_<64 hex>):  o que vai DENTRO do e-mail. Uso unico e curto
//     (30 min no "entrar", 72h nas boas-vindas); so serve para ser trocado por
//     uma sessao em POST /portal/session. O e-mail fica guardado em lugares
//     que nao controlamos (provedor, Safe Links, caixa compartilhada); com
//     link de uso unico, essa copia nao vira acesso depois de usada ou vencida.

export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const WELCOME_LINK_TTL_MS = 72 * 60 * 60 * 1000;
export const LOGIN_LINK_TTL_MS = 30 * 60 * 1000;
// Mesmo TTL do fluxo do operador (Marco 4): o link e para ser usado na hora.
const CONNECT_LINK_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_PORTAL_URL = 'https://app.playbooklab.com.br/painel';

// D7: sem Recruiter/Sales Navigator/caixas de organizacao.
const DISABLED_FEATURES = [
  'linkedin_recruiter',
  'linkedin_sales_navigator',
  'linkedin_organizations_mailboxes',
];

export interface PortalSession {
  tenantId: string;
  tenantName: string;
  contactEmail: string | null;
  tokenHash: string;
  limits: Record<RateLimitAction, number>;
}

interface PortalTokenRow {
  tenant_id: string;
}

interface PortalTokenFullRow {
  tenant_id: string;
  kind: string;
  status: string;
  expires_at: string;
}

// Por que um token nao serviu. So 'inexistente' conta como tentativa ruim no
// throttle: sessao vencida ou revogada e cliente legitimo com dado velho (ex.:
// saiu em outra aba), e punir isso bloqueava o proprio IP dele (review F2.21).
export type MotivoToken = 'inexistente' | 'inativo';

interface TenantRow {
  id: string;
  name: string;
  contact_email?: string | null;
  daily_message_limit?: number | null;
  daily_invitation_limit?: number | null;
}

interface TenantIdRow {
  id: string;
}

interface TenantIdOnlyRow {
  tenant_id: string;
}

interface BillingRow {
  status: string;
}

// URL da pagina do painel na landing. So https: o link carrega a credencial.
export function portalUrl(env: Env): string | null {
  const url = (env.PORTAL_URL ?? DEFAULT_PORTAL_URL).trim();
  return url.startsWith('https://') ? url : null;
}

// Token no FRAGMENTO (#t=): o navegador nunca o envia a servidor nenhum, entao
// nao aparece em log de acesso, proxy nem Referer. (O corpo do e-mail e outra
// historia; por isso o que vai por e-mail e link de uso unico.)
function portalLink(env: Env, token: string): string | null {
  const base = portalUrl(env);
  return base ? `${base}#t=${token}` : null;
}

export async function createPortalToken(
  env: Env,
  tenantId: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = `lk_portal_${randomHex32()}`;
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await supabaseInsert(env, 'portal_tokens', {
    tenant_id: tenantId,
    token_hash: await hashApiKey(token),
    kind: 'session',
    status: 'active',
    expires_at: expiresAt,
  });
  return { token, expiresAt };
}

// Link de acesso de uso unico, para ir por e-mail. Retorna a URL pronta.
export async function createPortalLink(
  env: Env,
  tenantId: string,
  ttlMs: number,
): Promise<string | null> {
  if (!portalUrl(env)) {
    return null;
  }
  const token = `lk_plink_${randomHex32()}`;
  await supabaseInsert(env, 'portal_tokens', {
    tenant_id: tenantId,
    token_hash: await hashApiKey(token),
    kind: 'link',
    status: 'active',
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  });
  return portalLink(env, token);
}

// ---------------------------------------------------------------------------
// Assentos adicionais (F2.29). 1 assento = 1 tenant, com assinatura, conta e
// chave proprias: nada muda na resolucao do account_id. O que existe e um
// GRUPO ligando os tenants do mesmo cliente, formado SO por acao autenticada
// do painel (nunca por e-mail igual; ver migration 0011).
// ---------------------------------------------------------------------------

// Identificador do grupo: o uuid do tenant que o abriu. Sem grupo, o proprio
// tenant e o grupo (formado de fato quando o segundo assento nasce).
export function groupIdOf(tenant: { id: string; group_id?: string | null }): string {
  return tenant.group_id ?? tenant.id;
}

// Referencia publica de um assento. O painel precisa nomear o irmao para o
// qual quer trocar, e nenhuma resposta do painel devolve tenant_id (mesma
// regra do account_id). Hash truncado do uuid: estavel entre chamadas e
// inutil para quem nao ja conhece o uuid de origem.
export async function seatRef(tenantId: string): Promise<string> {
  return (await hashApiKey(`seat:${tenantId}`)).slice(0, 24);
}

export interface SeatRow {
  id: string;
  name: string;
  group_id: string | null;
  created_at: string;
}

// Tenants do grupo, mais antigo primeiro (a ordem vira "Conta 1, 2, 3" no
// painel). Inclui o proprio, que pode ainda nao ter group_id gravado.
export async function tenantsDoGrupo(env: Env, tenantId: string): Promise<SeatRow[]> {
  const proprios = await supabaseSelect<SeatRow>(env, 'tenants', {
    id: `eq.${tenantId}`,
    status: 'eq.active',
    select: 'id,name,group_id,created_at',
    limit: '1',
  });
  const proprio = proprios[0];
  if (!proprio) return [];
  const grupo = groupIdOf(proprio);
  const irmaos = await supabaseSelect<SeatRow>(env, 'tenants', {
    group_id: `eq.${grupo}`,
    status: 'eq.active',
    select: 'id,name,group_id,created_at',
    order: 'created_at.asc',
  });
  const todos = irmaos.some((t) => t.id === proprio.id) ? irmaos : [proprio, ...irmaos];
  return todos.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

// Token de uso unico que autoriza o checkout a criar um assento DENTRO do
// grupo de quem esta logado. So o hash no banco, como todos os outros.
export async function createSeatToken(
  env: Env,
  tenantId: string,
  ttlMs: number,
): Promise<{ token: string; expiresAt: string }> {
  const token = `lk_seat_${randomHex32()}`;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await supabaseInsert(env, 'portal_tokens', {
    tenant_id: tenantId,
    token_hash: await hashApiKey(token),
    kind: 'seat',
    status: 'active',
    expires_at: expiresAt,
  });
  return { token, expiresAt };
}

// Le o token de assento SEM consumir: o checkout precisa do grupo antes de
// decidir o lock, e um 409 de "ja tem um checkout aberto" nao pode queimar o
// token de quem nem chegou a comprar.
export async function lerSeatToken(
  env: Env,
  seatToken: string,
): Promise<{ tenantId: string; groupId: string } | null> {
  const tokenHash = await hashApiKey(seatToken);
  const rows = await supabaseSelect<PortalTokenFullRow>(env, 'portal_tokens', {
    token_hash: `eq.${tokenHash}`,
    kind: 'eq.seat',
    status: 'eq.active',
    select: 'tenant_id,kind,status,expires_at',
    limit: '1',
  });
  const row = rows[0];
  if (!row || Date.parse(row.expires_at) <= Date.now()) return null;

  const tenants = await supabaseSelect<SeatRow>(env, 'tenants', {
    id: `eq.${row.tenant_id}`,
    status: 'eq.active',
    select: 'id,name,group_id,created_at',
    limit: '1',
  });
  const tenant = tenants[0];
  if (!tenant) return null;
  return { tenantId: row.tenant_id, groupId: groupIdOf(tenant) };
}

// Consome o token (active -> used, condicional: replay e corrida morrem aqui).
// Chamado imediatamente antes de criar o tenant do assento novo: um token
// nunca paga duas vendas, e a validacao acima ja garantiu o grupo.
export async function consumirSeatToken(env: Env, seatToken: string): Promise<boolean> {
  const usados = await supabaseUpdate<PortalTokenRow>(
    env,
    'portal_tokens',
    {
      token_hash: `eq.${await hashApiKey(seatToken)}`,
      kind: 'eq.seat',
      status: 'eq.active',
      expires_at: `gt.${new Date().toISOString()}`,
    },
    { status: 'used' },
  );
  return usados.length === 1;
}

// Abre o grupo no tenant de origem: o primeiro assento tambem precisa carregar
// o group_id, senao a lista so enxergaria os assentos novos. Condicional
// (is.null) para nao sobrescrever grupo ja existente.
export async function garantirGrupo(
  env: Env,
  tenantId: string,
  groupId: string,
): Promise<void> {
  await supabaseUpdate(
    env,
    'tenants',
    { id: `eq.${tenantId}`, group_id: 'is.null' },
    { group_id: groupId },
  );
}

// Troca um link (uso unico) por uma sessao. O consumo e um UPDATE condicional
// (active -> used), entao replay e corrida morrem aqui, igual aos connect_tokens.
export async function exchangeLinkToken(
  env: Env,
  linkToken: string,
): Promise<{ token: string; expiresAt: string } | { motivo: MotivoToken }> {
  const tokenHash = await hashApiKey(linkToken);
  const usados = await supabaseUpdate<PortalTokenRow>(
    env,
    'portal_tokens',
    {
      token_hash: `eq.${tokenHash}`,
      kind: 'eq.link',
      status: 'eq.active',
      expires_at: `gt.${new Date().toISOString()}`,
    },
    { status: 'used' },
  );
  const tenantId = usados.length === 1 ? usados[0]?.tenant_id : undefined;
  if (!tenantId) {
    // Caminho raro: so aqui olhamos se o link chegou a existir (usado ou
    // vencido nao pune o IP; lixo inventado pune).
    const existe = await supabaseSelect<PortalTokenRow>(env, 'portal_tokens', {
      token_hash: `eq.${tokenHash}`,
      select: 'tenant_id',
      limit: '1',
    });
    return { motivo: existe[0] ? 'inativo' : 'inexistente' };
  }
  const tenants = await supabaseSelect<TenantIdRow>(env, 'tenants', {
    id: `eq.${tenantId}`,
    status: 'eq.active',
    select: 'id',
    limit: '1',
  });
  if (!tenants[0]) {
    return { motivo: 'inativo' };
  }
  return createPortalToken(env, tenantId);
}

// Sessao -> tenant. Token inexistente, revogado, expirado, de tenant suspenso
// ou que seja LINK (nao sessao) nao serve; a rota responde 401 sem distinguir
// para o cliente, e o motivo so decide se o IP e punido.
export async function resolvePortalToken(
  env: Env,
  token: string,
): Promise<{ session: PortalSession } | { motivo: MotivoToken }> {
  const tokenHash = await hashApiKey(token);
  const rows = await supabaseSelect<PortalTokenFullRow>(env, 'portal_tokens', {
    token_hash: `eq.${tokenHash}`,
    select: 'tenant_id,kind,status,expires_at',
    limit: '1',
  });
  const row = rows[0];
  if (!row) {
    return { motivo: 'inexistente' };
  }
  const valida =
    row.kind === 'session' &&
    row.status === 'active' &&
    Date.parse(row.expires_at) > Date.now();
  if (!valida) {
    return { motivo: 'inativo' };
  }
  const tenants = await supabaseSelect<TenantRow>(env, 'tenants', {
    id: `eq.${row.tenant_id}`,
    status: 'eq.active',
    select: 'id,name,contact_email,daily_message_limit,daily_invitation_limit',
    limit: '1',
  });
  const tenant = tenants[0];
  if (!tenant) {
    return { motivo: 'inativo' };
  }
  return {
    session: {
      tenantId: row.tenant_id,
      tenantName: tenant.name,
      contactEmail: tenant.contact_email ?? null,
      tokenHash,
      limits: {
        messages: tenant.daily_message_limit ?? DAILY_LIMITS.messages,
        invitations: tenant.daily_invitation_limit ?? DAILY_LIMITS.invitations,
      },
    },
  };
}

// Seats ocupados na conta-mestra (F2.21, review I4): 1 por tenant que tem
// conta LinkedIn (ativa, pausada ou desconectada: todas existem na origem) OU
// assinatura ativa ainda sem conta (pagou e vai conectar). Conta pelo
// conjunto de tenants, para nao contar duas vezes quem tem as duas coisas.
//
// pendentesDesde (so o checkout usa): soma tambem os checkouts ainda dentro da
// validade do Pix. Sem isso, varios checkouts abertos ao mesmo tempo passavam
// na trava e quem pagasse por ultimo so descobria o "sem vaga" depois de pagar
// (review F2.21, M3). O connect NAO soma: pendente alheio nao pode barrar
// quem ja pagou.
export async function seatsInUse(
  env: Env,
  opts: { pendentesDesde?: string } = {},
): Promise<number> {
  const consultas = [
    supabaseSelect<TenantIdOnlyRow>(env, 'connected_accounts', {
      provider: 'eq.linkedin',
      status: 'in.(active,paused,disconnected)',
      select: 'tenant_id',
    }),
    supabaseSelect<TenantIdOnlyRow>(env, 'billing_subscriptions', {
      status: 'eq.active',
      select: 'tenant_id',
    }),
  ];
  if (opts.pendentesDesde) {
    consultas.push(
      supabaseSelect<TenantIdOnlyRow>(env, 'billing_subscriptions', {
        status: 'eq.pending',
        created_at: `gt.${opts.pendentesDesde}`,
        select: 'tenant_id',
      }),
    );
  }
  const linhas = (await Promise.all(consultas)).flat();
  return new Set(linhas.map((r) => r.tenant_id)).size;
}

// Link do wizard de hosted auth, com connect_token de uso unico (so o hash no
// banco). Mesmo desenho do connect:link do operador: o callback /hooks/connect
// usa o token para gravar a conta no tenant CERTO. Sem PUBLIC_BASE_URL (https)
// nao ha para onde o notify voltar: retorna null.
//
// voltarAoPainel: ao fim do wizard o cliente volta para o painel. So para o
// fluxo do proprio painel; o link que vai no webhook do integrador (reconexao
// automatica) mantem a tela de conclusao padrao (review M5).
export async function createConnectLink(
  env: Env,
  tenantId: string,
  purpose: 'create' | 'reconnect',
  reconnectAccountId?: string,
  opts: { voltarAoPainel?: boolean } = {},
): Promise<{ url: string; expiresAt: string } | null> {
  const base = env.PUBLIC_BASE_URL?.replace(/\/+$/, '');
  if (!base || !base.startsWith('https://')) {
    return null;
  }
  if (purpose === 'reconnect' && !reconnectAccountId) {
    return null;
  }

  const token = `lk_conn_${randomHex32()}`;
  const expiresAt = new Date(Date.now() + CONNECT_LINK_TTL_MS).toISOString();
  await supabaseInsert(env, 'connect_tokens', {
    tenant_id: tenantId,
    token_hash: await hashApiKey(token),
    purpose,
    status: 'pending',
    expires_at: expiresAt,
  });

  const body: Record<string, unknown> = {
    type: purpose,
    api_url: `https://${env.UNIPILE_DSN}`,
    expiresOn: expiresAt,
    name: token,
    notify_url: `${base}/hooks/connect`,
    single_use: true,
    disabled_features: DISABLED_FEATURES,
  };
  if (purpose === 'create') {
    body.providers = ['LINKEDIN'];
  } else {
    body.reconnect_account = reconnectAccountId;
  }
  const painel = opts.voltarAoPainel ? portalUrl(env) : null;
  if (painel) {
    body.success_redirect_url = `${painel}?conectado=1`;
    body.failure_redirect_url = `${painel}?conexao=falhou`;
    body.bypass_success_screen = true;
  }

  const res = await createHostedAuthLink(env, body);
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as { url?: string };
  return typeof data.url === 'string'
    ? { url: aplicarDominioProprio(data.url, env.UNIPILE_AUTH_HOST), expiresAt }
    : null;
}

// Dominio proprio da tela de conexao (F2.30). A origem hospeda o wizard num
// dominio dela; com um CNAME nosso apontando para la (e o certificado que eles
// emitem), a MESMA tela responde no nosso dominio. Aqui so trocamos o host do
// link, preservando caminho, query e fragmento (e no caminho que esta o token
// do wizard).
//
// Falha ABERTA de proposito: host mal configurado mantem o link original, que
// funciona. Derrubar a conexao de quem ja pagou para nao mostrar uma marca
// seria o erro maior; o sinal interno avisa o operador.
export function aplicarDominioProprio(url: string, host: string | undefined): string {
  const alvo = (host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!alvo) {
    return url;
  }
  try {
    const original = new URL(url);
    const trocada = new URL(`https://${alvo}`);
    // So host: um valor com caminho, usuario ou porta estranha nao entra.
    if (trocada.host !== alvo || trocada.pathname !== '/') {
      console.error('connect_auth_host_invalido');
      return url;
    }
    original.protocol = 'https:';
    original.host = alvo;
    return original.toString();
  } catch {
    console.error('connect_auth_host_invalido');
    return url;
  }
}

// ---------------------------------------------------------------------------
// E-mails de acesso. Todo conteudo e fixo; o unico valor dinamico e o link,
// montado por nos (URL configurada pelo operador + token hex). Nada do que o
// cliente digitou entra no HTML.
// ---------------------------------------------------------------------------

function emailHtml(titulo: string, texto: string, link: string, botao: string, validade: string): string {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:520px;margin:24px auto;background:#ffffff;border-radius:12px;padding:28px">
<p style="font-size:14px;font-weight:bold;color:#0F2736;margin:0 0 18px">Playbook API</p>
<h1 style="font-size:20px;color:#0F2736;margin:0 0 12px">${titulo}</h1>
<p style="font-size:15px;color:#333333;line-height:1.5;margin:0">${texto}</p>
<p style="margin:26px 0"><a href="${link}" style="background:#DDDF4C;color:#0F2736;padding:13px 22px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">${botao}</a></p>
<p style="font-size:12px;color:#777777;line-height:1.5;margin:0">Este link e pessoal, funciona uma unica vez e vale por ${validade}. Depois de aberto, o painel fica salvo no seu navegador. Se voce nao pediu este e-mail, pode ignorar.</p>
</div></body></html>`;
}

// Boas-vindas com o link do painel. Chamada em TODO pagamento confirmado; se
// protege sozinha reivindicando tenants.welcome_sent_at (NULL -> agora) num
// UPDATE condicional: retry do Asaas e evento em dobro nao duplicam. Se o
// envio falhar, devolve a vez (volta a NULL) e o proximo evento tenta de novo
// (review M1). Quem ja conectou o LinkedIn nao precisa do onboarding.
export async function enviarBoasVindas(env: Env, tenantId: string): Promise<void> {
  if (!emailConfigured(env) || !portalUrl(env)) {
    return;
  }
  const conectadas = await supabaseSelect<TenantIdRow>(env, 'connected_accounts', {
    tenant_id: `eq.${tenantId}`,
    status: 'eq.active',
    select: 'id',
    limit: '1',
  });
  if (conectadas[0]) {
    return;
  }

  const marcaDoClaim = new Date().toISOString();
  const reivindicado = await supabaseUpdate<TenantRow>(
    env,
    'tenants',
    {
      id: `eq.${tenantId}`,
      status: 'eq.active',
      welcome_sent_at: 'is.null',
      contact_email: 'not.is.null',
    },
    { welcome_sent_at: marcaDoClaim },
  );
  const email = reivindicado[0]?.contact_email;
  if (!email) {
    return;
  }

  let ok = false;
  try {
    const link = await createPortalLink(env, tenantId, WELCOME_LINK_TTL_MS);
    if (link) {
      ok = await sendEmail(env, {
        to: email,
        subject: 'Pagamento confirmado: conecte seu LinkedIn',
        text:
          'Seu pagamento da Playbook API foi confirmado.\n\n' +
          'Abra o painel para conectar seu LinkedIn e gerar sua chave de API:\n' +
          `${link}\n\n` +
          'Este link e pessoal, funciona uma unica vez e vale por 72 horas. ' +
          'Depois, peca um novo em "Entrar" no painel.',
        html: emailHtml(
          'Pagamento confirmado',
          'Sua assinatura esta ativa. Abra o painel para conectar seu LinkedIn e gerar sua chave de API. Leva dois minutos.',
          link,
          'Abrir meu painel',
          '72 horas',
        ),
      });
    }
  } finally {
    if (!ok) {
      console.error('portal_welcome_email_failed');
      // Devolve SO o proprio claim: se outro evento ja reivindicou de novo, a
      // marca dele fica intacta.
      await supabaseUpdate(
        env,
        'tenants',
        { id: `eq.${tenantId}`, welcome_sent_at: `eq.${marcaDoClaim}` },
        { welcome_sent_at: null },
      ).catch(() => {});
    }
  }
}

// "Entrar no painel": link novo (uso unico, 30 min) para cada conta paga com
// este e-mail. Quem chama ja normalizou o e-mail e aplicou o throttle. Sem
// conta correspondente, nao envia nada (a rota responde igual nos dois casos).
export async function enviarLinkDeAcesso(env: Env, email: string): Promise<void> {
  if (!portalUrl(env)) {
    return;
  }
  const tenants = await supabaseRpcSelect<TenantIdRow>(
    env,
    'find_tenants_by_contact_email',
    { p_email: email },
  );

  // Um link por GRUPO, nao por tenant (F2.29): quem tem dois assentos entra
  // uma vez e alterna entre as contas dentro do painel. Sem isso o e-mail
  // traria um link por assento, todos equivalentes.
  const grupos =
    tenants.length > 0
      ? await supabaseSelect<SeatRow>(env, 'tenants', {
          id: `in.(${tenants.map((t) => t.id).join(',')})`,
          select: 'id,name,group_id,created_at',
        })
      : [];
  const grupoDe = new Map(grupos.map((t) => [t.id, groupIdOf(t)]));

  const links: string[] = [];
  const jaEnviados = new Set<string>();
  for (const tenant of tenants) {
    const grupo = grupoDe.get(tenant.id) ?? tenant.id;
    if (jaEnviados.has(grupo)) continue;
    // So quem ja pagou ao menos uma vez (ativo ou em atraso) recebe acesso.
    const subs = await supabaseSelect<BillingRow>(env, 'billing_subscriptions', {
      tenant_id: `eq.${tenant.id}`,
      status: 'in.(active,overdue)',
      select: 'status',
      limit: '1',
    });
    if (!subs[0]) continue;
    const link = await createPortalLink(env, tenant.id, LOGIN_LINK_TTL_MS);
    if (link) {
      links.push(link);
      jaEnviados.add(grupo);
    }
  }
  if (links.length === 0) {
    return;
  }

  const principal = links[0]!;
  const extras =
    links.length > 1
      ? '\n\nVoce tem mais de uma conta. Links das demais:\n' + links.slice(1).join('\n')
      : '';
  const ok = await sendEmail(env, {
    to: email,
    subject: 'Seu link de acesso a Playbook API',
    text:
      'Aqui esta o link para entrar no seu painel da Playbook API:\n' +
      `${principal}${extras}\n\n` +
      'Este link e pessoal, funciona uma unica vez e vale por 30 minutos.',
    html: emailHtml(
      'Seu link de acesso',
      links.length > 1
        ? 'Aqui esta o link para entrar no painel da sua conta mais recente. Os links das demais contas estao na versao em texto deste e-mail.'
        : 'Aqui esta o link para entrar no seu painel da Playbook API.',
      principal,
      'Entrar no painel',
      '30 minutos',
    ),
  });
  if (!ok) {
    console.error('portal_access_email_failed');
  }
}
