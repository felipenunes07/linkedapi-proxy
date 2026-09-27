import type { Env } from '../types';

// Cliente da conta-mestra Unipile.
// Centraliza a base URL e a injecao do master token, para que NENHUMA rota fale
// com a Unipile sem passar por aqui. Assim o segredo fica num lugar so.

export async function unipileFetch(
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

  try {
    // redirect manual: a origem nao redireciona (medido em 2026-09-22), e
    // seguir um 3xx levaria o master token no header para outro host. Um
    // 3xx chega como resposta nao-ok e vira upstream_error.
    return await fetch(url, { ...init, headers, redirect: 'manual' });
  } catch {
    // Erro do runtime carregaria a URL completa (com o DSN) na message, que
    // acabaria no log do onError. Regra #2: DSN nunca em log.
    throw new Error('upstream_unreachable');
  }
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
  attachments: File[] = [],
): Promise<Response> {
  const form = new FormData();
  // Texto vazio so acontece quando a mensagem e so anexo.
  if (text.length > 0) form.set('text', text);
  form.set('account_id', accountId);
  for (const arquivo of attachments) form.append('attachments', arquivo, arquivo.name);
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

// Listar as contas conectadas na conta-mestra.
//   GET /api/v1/accounts
// Uso interno (API admin, fase 2): capacidade de seats e status das contas.
export function listAccounts(env: Env): Promise<Response> {
  return unipileFetch(env, '/accounts', { method: 'GET' });
}

// Criar link de hosted auth (usado pela reconexao automatizada, fase 2; o
// caminho de operador continua em scripts/connect.ts). O corpo segue a doc de
// hosted auth; nenhum campo vem de request de cliente.
export function createHostedAuthLink(
  env: Env,
  body: Record<string, unknown>,
): Promise<Response> {
  return unipileFetch(env, '/hosted/accounts/link', {
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
  opts: { limit?: string; cursor?: string; unread?: string; before?: string; after?: string } = {},
): Promise<Response> {
  const qs = new URLSearchParams({ account_id: accountId });
  if (opts.limit !== undefined) qs.set('limit', opts.limit);
  if (opts.cursor !== undefined) qs.set('cursor', opts.cursor);
  if (opts.unread !== undefined) qs.set('unread', opts.unread);
  if (opts.before !== undefined) qs.set('before', opts.before);
  if (opts.after !== undefined) qs.set('after', opts.after);
  return unipileFetch(env, `/chats?${qs.toString()}`, { method: 'GET' });
}

// ---------------------------------------------------------------------------
// Chamadas genericas (F2.41). Os endpoints novos montam o path e escolhem, um
// a um, os parametros que repassam: NUNCA se espalha o query/corpo do cliente
// direto aqui. O account_id entra so pelo argumento `query`/corpo montado na
// rota a partir do tenant resolvido. Tudo continua passando por unipileFetch,
// o unico ponto que injeta o master token.

export type Consulta = Record<string, string | string[] | undefined>;

function comConsulta(path: string, query: Consulta = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) qs.append(k, item);
    } else {
      qs.set(k, v);
    }
  }
  const texto = qs.toString();
  return texto ? `${path}?${texto}` : path;
}

export function unipileGet(env: Env, path: string, query?: Consulta): Promise<Response> {
  return unipileFetch(env, comConsulta(path, query), { method: 'GET' });
}

export function unipileJson(
  env: Env,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
  query?: Consulta,
): Promise<Response> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return unipileFetch(env, comConsulta(path, query), init);
}

export function unipileForm(
  env: Env,
  path: string,
  form: FormData,
  query?: Consulta,
): Promise<Response> {
  // Sem content-type: o FormData define multipart + boundary sozinho.
  return unipileFetch(env, comConsulta(path, query), { method: 'POST', body: form });
}
