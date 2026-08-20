import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { supabaseSelect, supabaseInsert, supabaseUpdate } from '../lib/supabase';
import { hashApiKey } from '../lib/hash';
import { getAccount } from '../lib/unipile';

// Callback da auto-conexao (Marco 4, hosted auth).
//
// Esta e a UNICA rota publica que escreve no banco, entao a barreira e em
// camadas (achados do security-reviewer incorporados):
//   1. THROTTLE (KV, fail-closed): teto de tentativas por token e por IP antes
//      de tocar banco ou Unipile. Sem binding de KV, a rota recusa (500).
//   2. TOKEN: o `name` do payload precisa casar (por hash) com um connect_token
//      pendente e valido. O consumo e um UPDATE condicional (pending -> used)
//      ANTES de qualquer escrita: replay e corrida morrem aqui. O token decide
//      o tenant; nunca qualquer id do payload.
//   3. PROPOSITO: token `create` so aceita CREATION_SUCCESS e exige que a conta
//      nao exista; token `reconnect` so aceita RECONNECTED e SO reativa a conta
//      que o proprio tenant ja tem. Um token nunca serve para o outro fluxo.
//   4. VERIFICACAO UPSTREAM: o notify nao tem assinatura documentada. So
//      vinculamos conta que a Unipile confirma existir na conta-mestra, ser
//      LINKEDIN e (no create) carregar o nosso token no campo `name` (e o
//      mecanismo oficial de correlacao: o que enviamos no link volta na conta).
//   5. BANCO: unique em connected_accounts.unipile_account_id (migration 0002)
//      garante que uma conta nunca aponta para dois tenants, mesmo sob corrida.
//
// Conflitos (conta ja de outro tenant) respondem 200 generico para nao virar
// oraculo; a anomalia sai por console.error SO com o id interno do token (uuid
// nosso), nunca token em claro nem account_id. Nada do payload e logado.

interface ConnectTokenRow {
  id: string;
  tenant_id: string;
  purpose: string;
}

interface ConnectedAccountRow {
  id: string;
  tenant_id: string;
  status: string;
}

interface UnipileAccount {
  type?: string;
  name?: string;
}

// purpose do token -> status de notify que ele aceita. Estrito de proposito:
// confirmar no primeiro teste real se a Unipile usa outros valores.
const STATUS_BY_PURPOSE: Record<string, string> = {
  create: 'CREATION_SUCCESS',
  reconnect: 'RECONNECTED',
};
const KNOWN_STATUSES = new Set(Object.values(STATUS_BY_PURPOSE));

// Tetos de tentativas (janela diaria UTC, contador em KV). O fluxo legitimo
// gera 1-2 notifies por token; 5 e folga. Por IP e mais alto porque os egress
// da Unipile podem concentrar varios notifies legitimos no mesmo IP.
const MAX_ATTEMPTS_PER_TOKEN = 5;
const MAX_ATTEMPTS_PER_IP = 100;
const ATTEMPT_TTL_SECONDS = 2 * 24 * 60 * 60;

// Token opaco tem tamanho conhecido (lk_conn_ + 64 hex). Cap folgado: nao
// hashear payload arbitrariamente grande de uma rota publica.
const MAX_NAME_LENGTH = 200;

function attemptKey(scope: string, id: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `connect:${scope}:${id}:${day}`;
}

// Read-modify-write como o recordUsage do rate limit: overshoot leve sob
// concorrencia e aceitavel, o teto e protecao de custo, nao contagem exata.
async function bumpAttempts(kv: KVNamespace, key: string): Promise<number> {
  const current = Number((await kv.get(key)) ?? '0') + 1;
  await kv.put(key, String(current), { expirationTtl: ATTEMPT_TTL_SECONDS });
  return current;
}

export const connectHooks = new Hono<{ Bindings: Env; Variables: Variables }>();

connectHooks.post('/', async (c) => {
  const kv = c.env.RATE_LIMIT;
  if (!kv) {
    // Rota publica que escreve no banco NAO opera sem o throttle (regra #4).
    return c.json({ error: 'rate_limit_unavailable' }, 500);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  const { status, account_id, name } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.length > MAX_NAME_LENGTH
  ) {
    return c.json({ error: 'missing_name' }, 400);
  }
  if (typeof account_id !== 'string' || account_id.length === 0) {
    return c.json({ error: 'missing_account_id' }, 400);
  }
  if (typeof status !== 'string' || !KNOWN_STATUSES.has(status)) {
    // Status que nao conhecemos: confirma o recebimento sem efeito algum
    // (a hosted auth so notifica sucesso; nao ha o que gravar aqui).
    return c.json({ ok: true, ignored: true });
  }

  // 1. Throttle por IP e por token, ANTES de banco/Unipile.
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const tokenHash = await hashApiKey(name);
  const ipAttempts = await bumpAttempts(kv, attemptKey('ip', ip));
  const tokenAttempts = await bumpAttempts(kv, attemptKey('token', tokenHash));
  if (ipAttempts > MAX_ATTEMPTS_PER_IP || tokenAttempts > MAX_ATTEMPTS_PER_TOKEN) {
    return c.json({ error: 'rate_limited' }, 429);
  }

  // 2. Consumo atomico do token: pending -> used, condicional e ANTES de
  // qualquer escrita. Se nada casou (inexistente, expirado, ja usado), 401.
  // Token queimado em fluxo que falha depois e o comportamento seguro: o
  // operador gera outro link.
  const nowIso = new Date().toISOString();
  const consumed = await supabaseUpdate<ConnectTokenRow>(
    c.env,
    'connect_tokens',
    {
      token_hash: `eq.${tokenHash}`,
      status: 'eq.pending',
      expires_at: `gt.${nowIso}`,
    },
    { status: 'used' },
  );
  const token = consumed[0];
  if (!token || consumed.length !== 1) {
    return c.json({ error: 'invalid_token' }, 401);
  }

  // 3. O proposito do token tem que casar com o status do notify.
  if (STATUS_BY_PURPOSE[token.purpose] !== status) {
    return c.json({ error: 'invalid_token' }, 401);
  }

  // 4. Verificacao upstream: a conta existe na NOSSA conta-mestra e e LinkedIn?
  const accountRes = await getAccount(c.env, account_id);
  if (!accountRes.ok) {
    return c.json({ error: 'account_verification_failed' }, 401);
  }
  const account = (await accountRes.json()) as UnipileAccount;
  if (account.type !== 'LINKEDIN') {
    return c.json({ error: 'account_verification_failed' }, 401);
  }

  if (token.purpose === 'reconnect') {
    // Reconexao NUNCA vincula conta nova: so reativa a conta que o proprio
    // tenant ja tem. account_id do payload fora disso e rejeicao.
    const own = await supabaseSelect<ConnectedAccountRow>(
      c.env,
      'connected_accounts',
      {
        tenant_id: `eq.${token.tenant_id}`,
        unipile_account_id: `eq.${account_id}`,
        select: 'id,tenant_id,status',
        limit: '1',
      },
    );
    const row = own[0];
    if (!row) {
      return c.json({ error: 'account_verification_failed' }, 401);
    }
    if (row.status === 'paused') {
      // Pausa (ex.: inadimplencia) nao se desfaz por reconexao. Sinal interno
      // apenas com o uuid do token (nada do payload).
      console.error(`connect_reconnect_on_paused token=${token.id}`);
      return c.json({ ok: true });
    }
    await supabaseUpdate(
      c.env,
      'connected_accounts',
      { id: `eq.${row.id}`, tenant_id: `eq.${token.tenant_id}` },
      { status: 'active' },
    );
    return c.json({ ok: true });
  }

  // purpose create: correlacao forte. O `name` que enviamos no link e o
  // mecanismo oficial de correlacao da hosted auth; a conta criada por este
  // link carrega o token. Conta com outro name (ex.: conectada manualmente)
  // NAO pode ser vinculada por este callback.
  if (account.name !== name) {
    return c.json({ error: 'account_verification_failed' }, 401);
  }

  const existing = await supabaseSelect<ConnectedAccountRow>(
    c.env,
    'connected_accounts',
    {
      unipile_account_id: `eq.${account_id}`,
      select: 'id,tenant_id,status',
      limit: '1',
    },
  );

  if (existing[0]) {
    if (existing[0].tenant_id !== token.tenant_id) {
      // Conflito cross-tenant: nunca re-vincular. Resposta generica (sem
      // oraculo) e sinal interno so com o uuid do token.
      console.error(`connect_account_conflict token=${token.id}`);
      return c.json({ ok: true });
    }
    if (existing[0].status === 'paused') {
      console.error(`connect_reactivate_on_paused token=${token.id}`);
      return c.json({ ok: true });
    }
    // Mesmo tenant (re-emissao legitima): reativa, idempotente.
    await supabaseUpdate(
      c.env,
      'connected_accounts',
      { id: `eq.${existing[0].id}`, tenant_id: `eq.${token.tenant_id}` },
      { status: 'active' },
    );
    return c.json({ ok: true });
  }

  // 1 seat = 1 conta: antes de vincular a nova, desativa qualquer outra conta
  // ativa do tenant (a resolucao no auth pegaria uma linha arbitraria).
  await supabaseUpdate(
    c.env,
    'connected_accounts',
    { tenant_id: `eq.${token.tenant_id}`, status: 'eq.active' },
    { status: 'disconnected' },
  );

  try {
    await supabaseInsert(c.env, 'connected_accounts', {
      tenant_id: token.tenant_id,
      unipile_account_id: account_id,
      provider: 'linkedin',
      status: 'active',
    });
  } catch (err) {
    // Corrida com outro notify: o unique do banco (migration 0002) decide.
    // Se a linha que venceu e do mesmo tenant, seguimos idempotentes; senao,
    // conflito (resposta generica, sinal interno).
    if (err instanceof Error && err.message === 'supabase_insert_failed:409') {
      const winner = await supabaseSelect<ConnectedAccountRow>(
        c.env,
        'connected_accounts',
        {
          unipile_account_id: `eq.${account_id}`,
          select: 'id,tenant_id,status',
          limit: '1',
        },
      );
      if (!winner[0] || winner[0].tenant_id !== token.tenant_id) {
        console.error(`connect_account_conflict token=${token.id}`);
        return c.json({ ok: true });
      }
    } else {
      throw err;
    }
  }

  // Resposta rapida e sem NENHUM dado interno (account_id nao volta).
  return c.json({ ok: true });
});
