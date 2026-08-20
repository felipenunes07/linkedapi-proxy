import type { Context, MiddlewareHandler } from 'hono';
import type { Env, Variables, RateLimitAction } from '../types';
import { supabaseRpc } from '../lib/supabase';
import { fireAndForget } from '../lib/async';

// Rate limit por chave (tenant) por janela diaria. Protege as contas de LinkedIn
// do excesso que as restringe, e a propria equipe testando. Obrigatorio ja na V1
// nas acoes de escrita (mensagem, convite). Regra inviolavel #4.
//
// Backend: Cloudflare KV (binding RATE_LIMIT). Escolhido por ser nativo do
// Worker, sem dependencia externa, e suficiente para limites diarios
// conservadores. Contrapartida: KV nao tem incremento atomico, entao sob alta
// concorrencia pode haver um leve overshoot; aceitavel para o alvo da V1. Se um
// dia precisar de contagem exata, trocar por Upstash Redis (INCR atomico).
//
// Numeros default e o porque estao em docs/decisoes.md (Marco 3).

// Limites default do plano basico vivem em src/lib/limits.ts (fase 2: o tenant
// pode ter override no banco; o efetivo chega resolvido em tenant.limits).
// Re-exportado daqui por compatibilidade com quem ja importava.
import { DAILY_LIMITS } from '../lib/limits';
export { DAILY_LIMITS };

// TTL da chave do contador: 2 dias cobre a janela diaria com folga e deixa o KV
// limpar sozinho. KV exige expirationTtl >= 60s.
const COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60;

// Segundos ate a proxima meia-noite UTC (fim da janela diaria). Vira o
// Retry-After da resposta 429.
function secondsUntilNextUtcMidnight(now: Date): number {
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((nextMidnight - now.getTime()) / 1000));
}

// Chave do contador: por tenant + acao + dia (UTC). NUNCA por account_id vindo
// do request.
function counterKey(tenantId: string, action: RateLimitAction): string {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  return `rl:${tenantId}:${action}:${day}`;
}

// Fabrica o middleware de rate limit para uma acao de escrita. Fica antes do
// handler: se ja estourou a janela, responde 429 ANTES de chamar a Unipile.
//
// So CHECA aqui; nao incrementa. A contagem sobe em `recordUsage`, chamada pelo
// handler apenas quando a escrita de fato chega a Unipile. Assim um 400
// (validacao) ou 502 (erro upstream) nao consome cota: so acoes reais contam.
export function rateLimit(
  action: RateLimitAction,
): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    const kv = c.env.RATE_LIMIT;
    if (!kv) {
      // Binding ausente = misconfiguracao. Nao seguimos sem protecao (regra #4):
      // melhor recusar do que escrever na Unipile sem limite.
      return c.json({ error: 'rate_limit_unavailable' }, 500);
    }

    // Limite efetivo do tenant (override do plano ou default), resolvido
    // server-side junto com o tenant. Nunca vem do request.
    const tenant = c.get('tenant');
    const limit = tenant.limits[action];
    const current = Number((await kv.get(counterKey(tenant.tenantId, action))) ?? '0');
    if (current >= limit) {
      const retryAfter = secondsUntilNextUtcMidnight(new Date());
      c.header('Retry-After', String(retryAfter));
      return c.json(
        { error: 'rate_limited', action, limit, retry_after: retryAfter },
        429,
      );
    }

    await next();
  };
}

// Registra uma acao de escrita que chegou a Unipile (passo "registrar uso" do
// pipeline). Incrementa o contador do dia. Chamar SO apos a escrita ter sido
// aceita, para nao penalizar cota em requests invalidos ou erros upstream.
// Ver nota sobre atomicidade (sem INCR no KV) no topo do arquivo.
export async function recordUsage(
  kv: KVNamespace,
  tenantId: string,
  action: RateLimitAction,
): Promise<void> {
  const key = counterKey(tenantId, action);
  const current = Number((await kv.get(key)) ?? '0');
  await kv.put(key, String(current + 1), {
    expirationTtl: COUNTER_TTL_SECONDS,
  });
}

// Uso persistente (fase 2): o contador KV expira em 2 dias; o historico para
// faturamento/auditoria vai para usage_daily via RPC atomica. Best-effort
// pos-resposta de proposito: telemetria nunca bloqueia nem derruba a request
// (o KV acima continua sendo a fonte do rate limit).
export function persistUsage(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  tenantId: string,
  action: RateLimitAction,
): void {
  fireAndForget(c, () =>
    supabaseRpc(c.env, 'increment_usage', {
      p_tenant_id: tenantId,
      p_action: action,
      p_day: new Date().toISOString().slice(0, 10),
    }),
  );
}
