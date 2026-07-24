import type { MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../types';

// Rate limit por chave por janela. Protege as contas de LinkedIn do excesso que
// as restringe. Obrigatorio ja na V1 nas acoes de escrita (mensagem, convite).
//
// TODO(Marco 3): implementar o contador (Cloudflare KV ou Upstash Redis).
// - chave do contador: por tenant/apiKey + janela de tempo
// - limites default: partir dos valores conservadores da Unipile (Provider Limits)
// - ao estourar: responder 429 com Retry-After
export const rateLimitMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: Variables;
}> = async (_c, next) => {
  // Placeholder: sem limite ate o Marco 3.
  await next();
};
