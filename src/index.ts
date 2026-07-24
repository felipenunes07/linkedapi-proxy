import { Hono } from 'hono';
import type { Env, Variables } from './types';
import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/rateLimit';

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

// TODO(Marco 1): POST /v1/messages  (enviar mensagem)
// TODO(Marco 3): POST /v1/invitations (enviar convite) + rate limit
// TODO(Marco 3): GET  /v1/chats       (listar chats)
v1.use('/messages', rateLimitMiddleware);
v1.use('/invitations', rateLimitMiddleware);

app.route('/v1', v1);

export default app;
