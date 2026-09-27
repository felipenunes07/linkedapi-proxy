import type { Context } from 'hono';
import type { Env, Variables } from '../types';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

// Erros vindos da origem (F2.41).
//
// Politica de sempre: o corpo cru da origem NUNCA sai (pode carregar host,
// DSN, account_id). O que passa a sair, alem do status, e o `reason`: o slug
// do tipo de erro (ex.: `errors/invalid_recipient` -> `invalid_recipient`),
// que diz ao integrador O QUE o LinkedIn recusou sem carregar nada de infra.
// So passa slug que casa com o formato esperado; qualquer outra coisa e
// descartada.

const FORMATO_TIPO = /^errors\/([a-z0-9_]{1,64})$/;

export async function motivoDaOrigem(res: Response): Promise<string | null> {
  try {
    const texto = await res.text();
    if (texto.length > 8192) return null;
    const corpo: unknown = JSON.parse(texto);
    const tipo =
      corpo && typeof corpo === 'object'
        ? (corpo as Record<string, unknown>).type
        : undefined;
    if (typeof tipo !== 'string') return null;
    return FORMATO_TIPO.exec(tipo)?.[1] ?? null;
  } catch {
    return null;
  }
}

// Resposta padrao para falha da origem nos endpoints novos:
//   - status em `naoEncontrado`, ou reason em `motivosNaoEncontrado` -> 404
//     not_found (recurso inexistente OU de outra conta: nunca distinguir,
//     para nao virar oraculo);
//   - 400 da origem -> 400 invalid_request (o que o cliente mandou foi
//     recusado, ex.: filtro de busca com id invalido);
//   - resto -> 502 upstream_error com upstream_status (+ reason quando houver).
export interface OpcoesErro {
  naoEncontrado?: readonly number[];
  motivosNaoEncontrado?: readonly string[];
}

export async function erroDaOrigem(
  c: Ctx,
  res: Response,
  opcoes: OpcoesErro = {},
): Promise<Response> {
  const naoEncontrado = opcoes.naoEncontrado ?? [404];
  if (naoEncontrado.includes(res.status)) {
    return c.json({ error: 'not_found' }, 404);
  }
  const reason = await motivoDaOrigem(res);
  if (reason && opcoes.motivosNaoEncontrado?.includes(reason)) {
    return c.json({ error: 'not_found' }, 404);
  }
  if (res.status === 400) {
    return c.json(reason ? { error: 'invalid_request', reason } : { error: 'invalid_request' }, 400);
  }
  return c.json(
    reason
      ? { error: 'upstream_error', upstream_status: res.status, reason }
      : { error: 'upstream_error', upstream_status: res.status },
    502,
  );
}
