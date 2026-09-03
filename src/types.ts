// Bindings do Worker (secrets + vars). Ver .dev.vars.example.
// IMPORTANT: UNIPILE_* e SUPABASE_SERVICE_ROLE_KEY sao segredos: so no servidor.
export interface Env {
  // Vars nao secretas
  ENVIRONMENT: string;

  // Segredos (Worker secrets / .dev.vars) - nunca expor ao cliente
  UNIPILE_DSN: string;
  UNIPILE_MASTER_TOKEN: string;
  // Supabase: a service role key contorna a RLS; vive so no servidor.
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;

  // Rate limit (Marco 3): contador por chave por janela. Binding declarado no
  // wrangler.jsonc. Sem ele, as rotas de escrita respondem 500 (nao seguimos
  // sem protecao, regra inviolavel #4).
  RATE_LIMIT: KVNamespace;

  // Fase 2 (opcionais; cada rota que depende de um deles FALHA FECHADO se o
  // secret nao estiver configurado):
  // Secret do hook de status de conta (registrado na origem via webhook:register).
  ACCOUNT_STATUS_HOOK_SECRET?: string;
  // Secret do hook de mensagem recebida (idem).
  MESSAGE_HOOK_SECRET?: string;
  // Token que o Asaas devolve no header asaas-access-token do webhook de cobranca.
  ASAAS_HOOK_TOKEN?: string;
  // Chave da API do Asaas (conta financeira). Sem ela, POST /checkout responde
  // 404: a superficie de cobranca desligada nem aparece. Segredo: so no
  // servidor, nunca em log nem em resposta.
  ASAAS_API_KEY?: string;
  // Base da API do Asaas. Default = producao. Aponte para
  // https://api-sandbox.asaas.com/v3 em dev, senao `npm run dev` cria cobranca
  // REAL (achado I6 do review do F2.14).
  ASAAS_BASE_URL?: string;
  // Preco mensal por seat, em BRL (default 57).
  PLAN_PRICE_BRL?: string;
  // Chave da API administrativa (operador). Sem ela, /admin nao existe (404).
  ADMIN_API_KEY?: string;
  // Capacidade de seats do piso da conta-mestra (default 10).
  SEAT_CAP?: string;
  // URL publica do Worker (para a reconexao automatizada montar o notify_url
  // do link de reconexao; mesma variavel dos scripts). Sem ela, a automacao de
  // link nao roda (so a notificacao de desconexao).
  PUBLIC_BASE_URL?: string;
}

// Acoes de escrita sujeitas a rate limit. Sao as que restringem contas no
// LinkedIn (enviar mensagem, enviar convite). Listar chats e leitura, sem limite.
export type RateLimitAction = 'messages' | 'invitations';

// Corpo aceito por POST /v1/messages. IMPORTANT: nao ha campo account_id aqui;
// se o cliente mandar um, e ignorado (o valor real vem do tenant, no servidor).
export interface SendMessageRequest {
  chat_id: string;
  text: string;
}

// Corpo aceito por POST /v1/invitations. Igual a mensagem: nao ha account_id
// aqui; o convite parte SEMPRE da conta do tenant resolvida no servidor.
// `provider_id` e o id interno do destinatario no LinkedIn (via Unipile).
export interface SendInvitationRequest {
  provider_id: string;
  message?: string;
}

// Tenant resolvido a partir da API key autenticada.
export interface Tenant {
  tenantId: string;
  // account_id da conta-mestra Unipile vinculada a este tenant.
  // Resolvido SEMPRE no servidor, nunca vindo do request.
  unipileAccountId: string;
  // Limites diarios efetivos (override por tenant, fase 2; default do plano
  // basico quando NULL no banco). Resolvidos no servidor junto com o tenant.
  limits: Record<RateLimitAction, number>;
  // Hash da chave usada nesta request (para rotacao/last_used_at; o valor em
  // claro nunca fica no contexto).
  keyHash: string;
}

// Variaveis por-request do Hono (context.var).
export interface Variables {
  tenant: Tenant;
}
