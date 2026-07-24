import type { MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../types';
import { resolveTenant } from '../lib/tenants';

// Autentica a API key NOSSA (header X-API-KEY) e injeta o tenant resolvido no
// contexto. Toda rota protegida usa este middleware. O account_id sai daqui,
// nunca do request.
export const authMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  const apiKey = c.req.header('X-API-KEY');
  if (!apiKey) {
    return c.json({ error: 'missing_api_key' }, 401);
  }

  const tenant = await resolveTenant(c.env, apiKey);
  if (!tenant) {
    return c.json({ error: 'invalid_api_key' }, 401);
  }

  c.set('tenant', tenant);
  await next();
};
