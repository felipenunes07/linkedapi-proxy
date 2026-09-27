import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { autenticarChave } from '../lib/tenants';
import { contasDoGrupo } from '../lib/contas';

// GET /v1/accounts (F2.42): as contas LinkedIn que a chave alcanca e o
// `account_id` de cada uma, para o cliente escolher em qualquer chamada.
//
// Montado ANTES do /v1 e com autenticacao propria (so a chave): listar as
// contas tem que funcionar justamente quando a conta da chave caiu ou nunca
// conectou, que e quando o cliente mais precisa ver o estado de cada uma. O
// authMiddleware exigiria LinkedIn ativo e responderia 409.

export const contas = new Hono<{ Bindings: Env; Variables: Variables }>();

contas.get('/', async (c) => {
  const apiKey = c.req.header('X-API-KEY');
  if (!apiKey) {
    return c.json({ error: 'missing_api_key' }, 401);
  }
  const chave = await autenticarChave(c.env, apiKey);
  if (!chave) {
    return c.json({ error: 'invalid_api_key' }, 401);
  }
  const items = await contasDoGrupo(c.env, chave.tenantId);
  return c.json({ ok: true, data: { items } });
});
