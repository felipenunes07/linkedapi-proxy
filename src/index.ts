import { Hono } from 'hono';
import type { Env, Variables } from './types';
import { authMiddleware } from './middleware/auth';
import { rateLimit, recordUsage, persistUsage } from './middleware/rateLimit';
import { sendMessage, sendInvitation, listChats } from './lib/unipile';
import {
  sanitizeMessageSent,
  sanitizeInvitationSent,
  sanitizeChatList,
} from './lib/sanitize';
import openapi from '../openapi.json';
import { docsHtml } from './lib/docs';
import { connectHooks } from './routes/connect';
import { eventHooks } from './routes/eventHooks';
import { selfservice } from './routes/selfservice';
import { admin } from './routes/admin';

// Data plane: o proxy. Pipeline por request:
//   autenticar chave -> resolver tenant + account_id (server-side)
//   -> rate limit -> injetar master token + DSN + account_id
//   -> rotear para a Unipile -> registrar uso -> responder.
// Regras invioláveis em CLAUDE.md. Nao aceitar account_id do request.

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Erro nao tratado: resposta no ErrorEnvelope da doc, nunca o texto padrao do
// Hono. Log SO de name/message (as mensagens internas sao codigos sem segredo:
// supabase_*_failed:<status> etc.); nunca o objeto/stack cru.
app.onError((err, c) => {
  console.error(`unhandled_error: ${err.name}: ${err.message}`);
  return c.json({ error: 'internal_error' }, 500);
});

// Rota inexistente no ErrorEnvelope tambem (404 agora e status documentado da
// API; o texto padrao do Hono destoaria da superficie publica).
app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.get('/health', (c) => c.json({ ok: true }));

// Documentacao publica (sem auth). E a superficie que a pessoa de teste abre
// para usar "a nossa API" sozinha. A spec e curada em openapi.json e NAO cita
// Unipile/DSN/account_id (regra de ouro do Marco 5).
//   GET /openapi.json -> a spec crua (Scalar consome daqui)
//   GET /docs         -> HTML do Scalar apontando para /openapi.json
app.get('/openapi.json', (c) => c.json(openapi));
app.get('/docs', (c) => c.html(docsHtml));

// Callback da auto-conexao (Marco 4). Rota publica SEM X-API-KEY: a seguranca
// vem do connect_token de uso unico + verificacao upstream (ver routes/connect).
// Nao entra no openapi.json: e infra, nao superficie do cliente.
app.route('/hooks/connect', connectHooks);

// Hooks de evento (fase 2): status de conta, mensagem recebida e cobranca.
// Publicos, mas atras de secret compartilhado (fail-closed; ver routes/eventHooks).
app.route('/hooks', eventHooks);

// API administrativa (operador). Sem ADMIN_API_KEY configurada, responde 404.
app.route('/admin', admin);

// Rotas protegidas da V1 (implementar por marco).
const v1 = new Hono<{ Bindings: Env; Variables: Variables }>();
v1.use('*', authMiddleware);

// Mapeamento de erro upstream por semantica de recurso (F2.13):
// - /messages (chat_id e recurso PRIVADO da conta): upstream 403 ou 404 vira
//   404 not_found unico, sem upstream_status. Nao distinguir "nao existe" de
//   "existe mas nao e seu" evita oraculo cross-tenant (provado no real em
//   2026-09-01: chat de outro tenant -> 403 da Unipile).
// - /invitations (provider_id e perfil PUBLICO): so upstream 404 vira
//   not_found; 403 do provider (limite, bloqueio) segue como upstream_error.
// - /chats (colecao, sem recurso no request): sem mapeamento.
const MESSAGES_NOT_FOUND_UPSTREAM = new Set([403, 404]);

// Rate limit so nas acoes de escrita (restringem contas no LinkedIn). Listar
// chats e leitura, sem limite. Cada acao tem seu proprio contador/limite.
v1.use('/messages', rateLimit('messages'));
v1.use('/invitations', rateLimit('invitations'));

// POST /v1/messages: enviar mensagem em chat existente.
// account_id NUNCA vem do corpo: usamos so o do tenant resolvido no servidor.
v1.post('/messages', async (c) => {
  const tenant = c.get('tenant');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const { chat_id, text } = (body ?? {}) as Record<string, unknown>;
  if (typeof chat_id !== 'string' || chat_id.length === 0) {
    return c.json({ error: 'missing_chat_id' }, 400);
  }
  if (typeof text !== 'string' || text.length === 0) {
    return c.json({ error: 'missing_text' }, 400);
  }

  // Um account_id no corpo e ignorado de proposito (regra de isolamento).
  const res = await sendMessage(c.env, chat_id, text, tenant.unipileAccountId);

  if (!res.ok) {
    // Recurso inexistente OU de outra conta: 404 unico, sem detalhe (F2.13).
    if (MESSAGES_NOT_FOUND_UPSTREAM.has(res.status)) {
      // Sinal interno (review F2.13): um 403 aqui tambem pode ser conta com
      // sessao caida na janela do webhook, e um not_found silencioso
      // esconderia isso do operador. So tenant (uuid nosso) + status.
      console.warn(
        `messages_not_found: tenant=${tenant.tenantId} upstream=${res.status}`,
      );
      return c.json({ error: 'not_found' }, 404);
    }
    // Normaliza o erro. Nao repassa corpo/detail cru da Unipile (pode carregar
    // DSN/host/account_id da conta-mestra). So o status upstream, que e inocuo.
    return c.json({ error: 'upstream_error', upstream_status: res.status }, 502);
  }

  // Escrita aceita: conta a cota so agora (nao penaliza 400/404/502).
  await recordUsage(c.env.RATE_LIMIT, tenant.tenantId, 'messages');
  persistUsage(c, tenant.tenantId, 'messages');

  // Whitelist: so os campos da nossa API. O corpo cru da Unipile carrega
  // account_id e metadados internos que nao saem daqui (white-label).
  const data: unknown = await res.json();
  return c.json({ ok: true, data: sanitizeMessageSent(data) });
});

// POST /v1/invitations: enviar convite de conexao.
// account_id NUNCA vem do corpo: usamos so o do tenant resolvido no servidor.
v1.post('/invitations', async (c) => {
  const tenant = c.get('tenant');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const { provider_id, message } = (body ?? {}) as Record<string, unknown>;
  if (typeof provider_id !== 'string' || provider_id.length === 0) {
    return c.json({ error: 'missing_provider_id' }, 400);
  }
  let msg: string | undefined;
  if (message !== undefined) {
    if (typeof message !== 'string') {
      return c.json({ error: 'invalid_message' }, 400);
    }
    msg = message;
  }

  // Um account_id no corpo e ignorado de proposito (regra de isolamento).
  const res = await sendInvitation(
    c.env,
    provider_id,
    tenant.unipileAccountId,
    msg,
  );

  if (!res.ok) {
    // Perfil inexistente: 404 unico (F2.13). 403 do provider (limite,
    // bloqueio) NAO e not_found e segue como upstream_error.
    if (res.status === 404) {
      console.warn(
        `invitations_not_found: tenant=${tenant.tenantId} upstream=404`,
      );
      return c.json({ error: 'not_found' }, 404);
    }
    // So o status upstream, nunca o corpo cru da Unipile (pode carregar
    // DSN/host/account_id da conta-mestra). Mesma politica de /messages.
    return c.json({ error: 'upstream_error', upstream_status: res.status }, 502);
  }

  // Convite aceito: conta a cota so agora (nao penaliza 400/502).
  await recordUsage(c.env.RATE_LIMIT, tenant.tenantId, 'invitations');
  persistUsage(c, tenant.tenantId, 'invitations');

  // Whitelist: so os campos da nossa API (white-label, mesma politica de /messages).
  const data: unknown = await res.json();
  return c.json({ ok: true, data: sanitizeInvitationSent(data) });
});

// GET /v1/chats: listar chats do tenant (para obter chat_id). Leitura, sem rate
// limit. O filtro por account_id e server-side: o tenant so ve os proprios chats.
v1.get('/chats', async (c) => {
  const tenant = c.get('tenant');

  // Repassamos so paginacao. account_id NUNCA vem do request.
  const res = await listChats(c.env, tenant.unipileAccountId, {
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });

  if (!res.ok) {
    return c.json({ error: 'upstream_error', upstream_status: res.status }, 502);
  }

  // Whitelist por item: o objeto de chat da Unipile carrega o account_id da
  // conta-mestra; aqui so passam os campos de ChatSummary (white-label).
  const data: unknown = await res.json();
  return c.json({ ok: true, data: sanitizeChatList(data) });
});

// Self-service do tenant (fase 2): rotacao de chave e webhook. Dentro do /v1,
// ou seja, atras do mesmo authMiddleware das demais rotas.
v1.route('/', selfservice);

app.route('/v1', v1);

export default app;
