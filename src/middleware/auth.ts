import type { MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../types';
import { resolveTenant, touchApiKey } from '../lib/tenants';
import { fireAndForget } from '../lib/async';

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

  // Auditoria (fase 2): last_used_at da chave, best-effort pos-resposta.
  // Deduplicado por KV (1 escrita/hora por chave): sem isso, cada request
  // autenticado viraria um PATCH no banco.
  fireAndForget(c, async () => {
    const kv = c.env.RATE_LIMIT;
    const dedupeKey = `touch:${tenant.keyHash}`;
    if (kv) {
      if (await kv.get(dedupeKey)) {
        return;
      }
      await kv.put(dedupeKey, '1', { expirationTtl: 3600 });
    }
    await touchApiKey(c.env, tenant.keyHash, tenant.tenantId);
  });

  c.set('tenant', tenant);
  await next();
};
