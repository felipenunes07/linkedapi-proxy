import type { RateLimitAction } from '../types';

// Limites default do plano basico, por acao, por dia (UTC), por tenant.
// Conservadores, partindo dos recomendados pela Unipile (Provider Limits):
// convites 80-100/dia e ~200/semana, mensagens ~100/dia. Ficamos abaixo de
// proposito para deixar margem.
//
// Fase 2: o tenant pode ter override no banco (tenants.daily_*_limit, migration
// 0004, teto 1000 via CHECK); NULL = estes defaults. A resolucao acontece em
// resolveTenant; o rate limiter usa sempre tenant.limits.
//
// Expansao dos endpoints (F2.41): cada familia de chamada que toca o LinkedIn
// ao vivo tem o seu contador. A origem recomenda ~100 visitas de perfil/dia,
// ~1000 resultados de busca/dia e, para o resto ("empresas, posts, comentar,
// reagir"), ~100 por acao por dia. Leitura de conversa NAO entra aqui: a
// caixa de entrada e sincronizada do lado da origem e ler nao toca o LinkedIn.
export const DAILY_LIMITS: Record<RateLimitAction, number> = {
  messages: 80,
  invitations: 30, // ~210/semana, respeita tambem o teto semanal (~200) de convites
  // Perfil de pessoa ou pagina de empresa aberta (conta como visita).
  profile_views: 80,
  // Soma de RESULTADOS de busca devolvidos no dia (nao de chamadas): e assim
  // que a recomendacao da origem e medida.
  search_results: 1000,
  // Rede e conta: conexoes, seguidores, convites pendentes, o proprio perfil,
  // saldo de InMail, ids de filtro de busca.
  network_reads: 200,
  // Posts, comentarios e reacoes lidos.
  content_reads: 100,
  // Aceitar, recusar ou cancelar convite.
  invitation_responses: 50,
  // Reagir a post/comentario/mensagem e endossar competencia.
  reactions: 60,
  comments: 30,
  // Publicar no feed: pouco por dia, e o que mais chama atencao.
  posts: 5,
  // Editar/apagar mensagem, marcar conversa como lida.
  chat_actions: 100,
};

// So estas duas tem override por tenant no banco (colunas da migration 0004).
// As demais usam sempre o default acima.
export function effectiveLimits(overrides: {
  daily_message_limit?: number | null;
  daily_invitation_limit?: number | null;
}): Record<RateLimitAction, number> {
  return {
    ...DAILY_LIMITS,
    messages: overrides.daily_message_limit ?? DAILY_LIMITS.messages,
    invitations: overrides.daily_invitation_limit ?? DAILY_LIMITS.invitations,
  };
}
