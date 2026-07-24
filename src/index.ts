import { Hono } from 'hono';
import type { Env, Variables } from './types';
import { authMiddleware } from './middleware/auth';
import { rateLimit, recordUsage } from './middleware/rateLimit';
import { sendMessage, sendInvitation, listChats } from './lib/unipile';
import openapi from '../openapi.json';
import { docsHtml } from './lib/docs';

// Data plane: o proxy. Pipeline por request:
//   autenticar chave -> resolver tenant + account_id (server-side)
//   -> rate limit -> injetar master token + DSN + account_id
//   -> rotear para a Unipile -> registrar uso -> responder.
// Regras invioláveis em CLAUDE.md. Nao aceitar account_id do request.

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/health', (c) => c.json({ ok: true }));

// Documentacao publica (sem auth). E a superficie que a pessoa de teste abre
// para usar "a nossa API" sozinha. A spec e curada em openapi.json e NAO cita
// Unipile/DSN/account_id (regra de ouro do Marco 5).
//   GET /openapi.json -> a spec crua (Scalar consome daqui)
//   GET /docs         -> HTML do Scalar apontando para /openapi.json
app.get('/openapi.json', (c) => c.json(openapi));
app.get('/docs', (c) => c.html(docsHtml));

// Rotas protegidas da V1 (implementar por marco).
const v1 = new Hono<{ Bindings: Env; Variables: Variables }>();
v1.use('*', authMiddleware);

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
    // Normaliza o erro. Nao repassa corpo/detail cru da Unipile (pode carregar
    // DSN/host/account_id da conta-mestra). So o status upstream, que e inocuo.
    return c.json({ error: 'upstream_error', upstream_status: res.status }, 502);
  }

  // Escrita aceita: conta a cota so agora (nao penaliza 400/502).
  await recordUsage(c.env.RATE_LIMIT, tenant.tenantId, 'messages');

  const data: unknown = await res.json();
  return c.json({ ok: true, data });
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
    // So o status upstream, nunca o corpo cru da Unipile (pode carregar
    // DSN/host/account_id da conta-mestra). Mesma politica de /messages.
    return c.json({ error: 'upstream_error', upstream_status: res.status }, 502);
  }

  // Convite aceito: conta a cota so agora (nao penaliza 400/502).
  await recordUsage(c.env.RATE_LIMIT, tenant.tenantId, 'invitations');

  const data: unknown = await res.json();
  return c.json({ ok: true, data });
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

  const data: unknown = await res.json();
  return c.json({ ok: true, data });
});

app.route('/v1', v1);

export default app;
