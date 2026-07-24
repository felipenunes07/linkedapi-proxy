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

// TODO(Marco 3): enviar convite de conexao; listar chats.
// O account_id sempre entra a partir do tenant resolvido (nunca do request).
