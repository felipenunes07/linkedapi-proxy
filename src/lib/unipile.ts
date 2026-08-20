import type { Env } from '../types';

// Cliente da conta-mestra Unipile.
// Centraliza a base URL e a injecao do master token, para que NENHUMA rota fale
// com a Unipile sem passar por aqui. Assim o segredo fica num lugar so.

export function unipileFetch(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  // Base: https://{DSN}/api/v1/...  (confirmar path exato na doc da Unipile)
  const url = `https://${env.UNIPILE_DSN}/api/v1${path}`;

  const headers = new Headers(init.headers);
  // Header de autenticacao da Unipile. IMPORTANT: injetado aqui, no servidor.
  headers.set('X-API-KEY', env.UNIPILE_MASTER_TOKEN);
  headers.set('accept', 'application/json');

  return fetch(url, { ...init, headers });
}

// Enviar mensagem em chat existente.
//   POST /api/v1/chats/{chat_id}/messages  (multipart/form-data, campo `text`)
// O `account_id` e opcional na Unipile e serve de guard: impede enviar em um
// chat que nao pertence a esta conta. Nós o injetamos SEMPRE, com o valor
// resolvido do tenant (server-side), nunca com o que veio do request.
export function sendMessage(
  env: Env,
  chatId: string,
  text: string,
  accountId: string,
): Promise<Response> {
  const form = new FormData();
  form.set('text', text);
  form.set('account_id', accountId);
  // Nao setar content-type: o FormData define multipart + boundary sozinho.
  return unipileFetch(env, `/chats/${encodeURIComponent(chatId)}/messages`, {
    method: 'POST',
    body: form,
  });
}

// Enviar convite de conexao no LinkedIn.
//   POST /api/v1/users/invite  (application/json)
//   body: { provider_id, account_id, message? }
// `provider_id` e o id interno do destinatario (o cliente resolve isso na
// Unipile). O `account_id` e SEMPRE o do tenant, injetado aqui no servidor:
// e a conta a partir da qual o convite parte.
export function sendInvitation(
  env: Env,
  providerId: string,
  accountId: string,
  message?: string,
): Promise<Response> {
  const body: Record<string, string> = {
    provider_id: providerId,
    account_id: accountId,
  };
  if (message !== undefined) {
    body.message = message;
  }
  return unipileFetch(env, '/users/invite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Consultar uma conta conectada na conta-mestra.
//   GET /api/v1/accounts/{account_id}
// Usado pelo callback da auto-conexao (Marco 4) como verificacao: o notify da
// hosted auth NAO tem assinatura documentada, entao nunca confiamos so no
// payload. So vinculamos um account_id que a PROPRIA Unipile confirma existir
// na nossa conta-mestra (e ser LINKEDIN).
export function getAccount(env: Env, accountId: string): Promise<Response> {
  return unipileFetch(env, `/accounts/${encodeURIComponent(accountId)}`, {
    method: 'GET',
  });
}

// Listar chats de uma conta.
//   GET /api/v1/chats?account_id=...&limit=...&cursor=...
// Filtramos SEMPRE pelo account_id do tenant (server-side): a conta-mestra tem
// varias contas conectadas, e sem esse filtro o tenant veria chats de outros.
// `limit`/`cursor` sao repassados como vieram (paginacao), nunca o account_id.
export function listChats(
  env: Env,
  accountId: string,
  opts: { limit?: string; cursor?: string } = {},
): Promise<Response> {
  const qs = new URLSearchParams({ account_id: accountId });
  if (opts.limit !== undefined) qs.set('limit', opts.limit);
  if (opts.cursor !== undefined) qs.set('cursor', opts.cursor);
  return unipileFetch(env, `/chats?${qs.toString()}`, { method: 'GET' });
}
