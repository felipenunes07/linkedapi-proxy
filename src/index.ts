import { Hono } from 'hono';
import type { Env, Variables } from './types';
import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { sendMessage } from './lib/unipile';

// Data plane: o proxy. Pipeline por request:
//   autenticar chave -> resolver tenant + account_id (server-side)
//   -> rate limit -> injetar master token + DSN + account_id
//   -> rotear para a Unipile -> registrar uso -> responder.
// Regras invioláveis em CLAUDE.md. Nao aceitar account_id do request.

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.get('/health', (c) => c.json({ ok: true }));

// Rotas protegidas da V1 (implementar por marco).
const v1 = new Hono<{ Bindings: Env; Variables: Variables }>();
v1.use('*', authMiddleware);

// TODO(Marco 3): POST /v1/invitations (enviar convite) + rate limit
// TODO(Marco 3): GET  /v1/chats       (listar chats)
v1.use('/messages', rateLimitMiddleware);
v1.use('/invitations', rateLimitMiddleware);

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
    return c.json({ error: 'unipile_error', upstream_status: res.status }, 502);
  }

  const data: unknown = await res.json();
  return c.json({ ok: true, data });
});

app.route('/v1', v1);

export default app;
