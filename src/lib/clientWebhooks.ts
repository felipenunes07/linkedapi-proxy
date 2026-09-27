import type { Env } from '../types';
import { supabaseDelete, supabaseInsert, supabaseSelect, supabaseUpdate } from './supabase';
import { randomHex32 } from './random';

// Webhooks do cliente, por evento (F2.43). Como no dashboard da origem: cada
// conta (tenant) tem quantos webhooks quiser, ate o teto, e cada um diz quais
// eventos o disparam. Cada webhook tem o SEU secret de assinatura, gerado por
// nos e mostrado uma unica vez, na criacao.
//
// O secret nunca sai daqui para uma resposta de listagem: PUBLIC_SELECT nao o
// inclui, e so webhooksDoEvento (usado na entrega) o le.

// Catalogo de eventos que o cliente pode assinar. A ordem e a do painel.
export const WEBHOOK_EVENTS = [
  'account.disconnected',
  'account.reconnected',
  'message.received',
  'message.read',
  'message.reaction',
  'message.edited',
  'message.deleted',
  'message.delivered',
  'relation.new',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

// O que o endpoint unico de antes recebia. E o que um webhook criado pelo
// caminho legado (PUT /v1/webhook) assina, para nada mudar para quem ja usa.
export const LEGACY_EVENTS: readonly WebhookEvent[] = [
  'message.received',
  'account.disconnected',
  'account.reconnected',
];

export const MAX_WEBHOOKS_PER_TENANT = 10;
const MAX_NAME = 60;
const LEGACY_NAME = 'Webhook principal';
const PUBLIC_SELECT = 'id,name,url,events,created_at';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicWebhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  created_at: string;
}

interface DeliveryRow {
  url: string;
  secret: string;
}

// Lista de eventos vinda do cliente: nao vazia, so do catalogo, sem repetir.
// Qualquer item desconhecido invalida tudo (nunca gravar metade do pedido).
export function parseEvents(value: unknown): WebhookEvent[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const set = new Set<WebhookEvent>();
  for (const item of value) {
    if (typeof item !== 'string' || !(WEBHOOK_EVENTS as readonly string[]).includes(item)) {
      return null;
    }
    set.add(item as WebhookEvent);
  }
  // Ordem do catalogo, para a lista gravada nao depender da ordem do clique.
  return WEBHOOK_EVENTS.filter((e) => set.has(e));
}

// Nome livre, so para o cliente se achar na lista. Sem caractere de controle.
export function parseName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (name.length === 0 || name.length > MAX_NAME) return null;
  if (/[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

export function isWebhookId(value: string): boolean {
  return UUID.test(value);
}

function novoSecret(): string {
  return `lk_whsec_${randomHex32()}`;
}

// Projecao explicita, alem do select: o que sai numa resposta nunca depende
// so da query ter pedido as colunas certas.
function publico(row: PublicWebhook): PublicWebhook {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events,
    created_at: row.created_at,
  };
}

export async function listWebhooks(env: Env, tenantId: string): Promise<PublicWebhook[]> {
  const rows = await supabaseSelect<PublicWebhook>(env, 'client_webhooks', {
    tenant_id: `eq.${tenantId}`,
    select: PUBLIC_SELECT,
    order: 'created_at.asc',
  });
  return rows.map(publico);
}

// Cria um webhook. `limit` quando a conta ja esta no teto. O secret volta
// aqui UMA vez; depois disso so a entrega o le.
export async function createWebhook(
  env: Env,
  tenantId: string,
  input: { name: string; url: string; events: WebhookEvent[] },
): Promise<{ webhook: PublicWebhook; secret: string } | 'limit'> {
  const atuais = await supabaseSelect<{ id: string }>(env, 'client_webhooks', {
    tenant_id: `eq.${tenantId}`,
    select: 'id',
  });
  if (atuais.length >= MAX_WEBHOOKS_PER_TENANT) return 'limit';
  const secret = novoSecret();
  const [row] = await supabaseInsert<PublicWebhook & { secret?: string }>(env, 'client_webhooks', {
    tenant_id: tenantId,
    name: input.name,
    url: input.url,
    secret,
    events: input.events,
  });
  if (!row) throw new Error('webhook_insert_empty');
  return { webhook: publico(row), secret };
}

// Remove um webhook DESTE tenant. O filtro por tenant_id e o que impede um
// cliente de apagar o webhook de outro com um id adivinhado.
export async function deleteWebhook(env: Env, tenantId: string, id: string): Promise<boolean> {
  const rows = await supabaseSelect<{ id: string }>(env, 'client_webhooks', {
    id: `eq.${id}`,
    tenant_id: `eq.${tenantId}`,
    select: 'id',
    limit: '1',
  });
  if (!rows[0]) return false;
  await supabaseDelete(env, 'client_webhooks', { id: `eq.${id}`, tenant_id: `eq.${tenantId}` });
  return true;
}

// Entrega: os webhooks deste tenant que assinam este evento.
export async function webhooksDoEvento(
  env: Env,
  tenantId: string,
  event: WebhookEvent,
): Promise<DeliveryRow[]> {
  return supabaseSelect<DeliveryRow>(env, 'client_webhooks', {
    tenant_id: `eq.${tenantId}`,
    events: `cs.{${event}}`,
    select: 'url,secret',
  });
}

// ---------------------------------------------------------------- legado
// PUT/GET/DELETE /v1/webhook (e /portal/webhook) falavam de UM endpoint. Agora
// eles operam no webhook mais antigo da conta, o "principal": quem integrou
// assim segue vendo e trocando o mesmo endpoint de sempre.

async function principal(env: Env, tenantId: string): Promise<PublicWebhook | undefined> {
  const rows = await supabaseSelect<PublicWebhook>(env, 'client_webhooks', {
    tenant_id: `eq.${tenantId}`,
    select: PUBLIC_SELECT,
    order: 'created_at.asc',
    limit: '1',
  });
  return rows[0];
}

export async function getLegacyUrl(env: Env, tenantId: string): Promise<string | null> {
  return (await principal(env, tenantId))?.url ?? null;
}

// Troca a URL do principal e gera secret novo (como o PUT sempre fez); sem
// webhook ainda, cria o principal com os eventos de antes.
export async function putLegacy(env: Env, tenantId: string, url: string): Promise<string> {
  const atual = await principal(env, tenantId);
  if (!atual) {
    const criado = await createWebhook(env, tenantId, {
      name: LEGACY_NAME,
      url,
      events: [...LEGACY_EVENTS],
    });
    if (criado === 'limit') throw new Error('webhook_limit_unreachable');
    return criado.secret;
  }
  const secret = novoSecret();
  await supabaseUpdate(
    env,
    'client_webhooks',
    { id: `eq.${atual.id}`, tenant_id: `eq.${tenantId}` },
    { url, secret },
  );
  return secret;
}

export async function deleteLegacy(env: Env, tenantId: string): Promise<void> {
  const atual = await principal(env, tenantId);
  if (atual) await deleteWebhook(env, tenantId, atual.id);
}
