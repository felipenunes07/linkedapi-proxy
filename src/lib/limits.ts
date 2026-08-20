import type { RateLimitAction } from '../types';

// Limites default do plano basico, por acao, por dia (UTC), por tenant.
// Conservadores, partindo dos recomendados pela Unipile (Provider Limits):
// convites 80-100/dia e ~200/semana, mensagens ~100/dia. Ficamos abaixo de
// proposito para deixar margem.
//
// Fase 2: o tenant pode ter override no banco (tenants.daily_*_limit, migration
// 0004, teto 1000 via CHECK); NULL = estes defaults. A resolucao acontece em
// resolveTenant; o rate limiter usa sempre tenant.limits.
export const DAILY_LIMITS: Record<RateLimitAction, number> = {
  messages: 80,
  invitations: 30, // ~210/semana, respeita tambem o teto semanal (~200) de convites
};
