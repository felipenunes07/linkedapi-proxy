import type { MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../types';
import { autenticarChave, resolverContaDoTenant, touchApiKey } from '../lib/tenants';
import { lerContaPedida, tenantDaContaPedida } from '../lib/contas';
import { fireAndForget } from '../lib/async';

// Autentica a API key NOSSA (header X-API-KEY) e injeta o tenant resolvido no
// contexto. Toda rota protegida usa este middleware. O account_id da origem
// sai daqui, nunca do request.
//
// F2.42: a request pode escolher outra conta do MESMO grupo com o nosso
// `account_id` (query, JSON ou multipart). A troca acontece so aqui: toda
// rota le c.get('tenant') e passa a agir, contar cota e entregar webhook pela
// conta escolhida, sem saber que houve escolha. Conta fora do grupo = 404
// account_not_found, sem tocar a origem.
export const authMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (c, next) => {
  const apiKey = c.req.header('X-API-KEY');
  if (!apiKey) {
    return c.json({ error: 'missing_api_key' }, 401);
  }

  // Chave inexistente/revogada ou tenant suspenso: 401.
  const chave = await autenticarChave(c.env, apiKey);
  if (!chave) {
    return c.json({ error: 'invalid_api_key' }, 401);
  }

  const pedida = await lerContaPedida(c);
  if ('error' in pedida) {
    return pedida.status === 413
      ? c.json({ error: pedida.error, max_bytes: pedida.max_bytes }, 413)
      : c.json({ error: pedida.error }, pedida.status);
  }
  let tenantId = chave.tenantId;
  if (pedida.accountId) {
    const escolhido = await tenantDaContaPedida(c.env, chave.tenantId, pedida.accountId);
    if (!escolhido) {
      return c.json({ error: 'account_not_found' }, 404);
    }
    tenantId = escolhido;
  }

  const resolved = await resolverContaDoTenant(c.env, tenantId, chave, chave.tenantRow);
  if ('error' in resolved) {
    // Conta sem LinkedIn ativo: 402 (pagamento em atraso) ou 409 (sessao
    // caida / nunca conectou), para o cliente saber o que fazer (F2.22). O
    // motivo e sempre de uma conta do proprio cliente. Nenhum dos casos
    // chega a Unipile.
    return c.json({ error: resolved.error }, resolved.status);
  }
  const tenant =
    tenantId === chave.tenantId
      ? resolved.tenant
      : { ...resolved.tenant, accountIdEscolhido: pedida.accountId };

  // Auditoria (fase 2): last_used_at da chave, best-effort pos-resposta.
  // Deduplicado por KV (1 escrita/hora por chave): sem isso, cada request
  // autenticado viraria um PATCH no banco. Sempre no tenant DONO da chave.
  fireAndForget(c, async () => {
    const kv = c.env.RATE_LIMIT;
    const dedupeKey = `touch:${tenant.keyHash}`;
    if (kv) {
      if (await kv.get(dedupeKey)) {
        return;
      }
      await kv.put(dedupeKey, '1', { expirationTtl: 3600 });
    }
    await touchApiKey(c.env, tenant.keyHash, tenant.keyTenantId);
  });

  c.set('tenant', tenant);
  await next();
};
