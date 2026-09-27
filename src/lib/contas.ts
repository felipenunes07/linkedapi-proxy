import type { Context } from 'hono';
import type { Env, Variables } from '../types';
import { seatRef, tenantsDoGrupo } from './portal';
import { supabaseSelect } from './supabase';
import { lerBytes, MAX_BYTES_ANEXOS, MAX_BYTES_JSON } from './entrada';

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

// Uma chave, varias contas (F2.42). Mesmo modelo da origem: o cliente manda
// `account_id` em qualquer chamada para dizer com qual LinkedIn a acao
// acontece. Sem ele, age a conta da propria chave, como sempre foi.
//
// O `account_id` e NOSSO, nunca o da origem: `acc_` + a mesma ref que o
// painel ja usa para alternar assento (hash truncado do tenant). Estavel
// entre reconexoes (a origem troca de id quando a sessao e refeita; o assento
// nao muda) e inutil fora do grupo.
//
// Fronteira de seguranca: o id so escolhe entre os assentos do GRUPO da
// chave, e o grupo so e formado por acao autenticada do painel (migration
// 0011). Id de outro cliente, id da origem ou id inventado dao a mesma
// resposta (404 account_not_found), sem tocar a origem: nada vira oraculo.

const PREFIXO = 'acc_';
const FORMATO = /^acc_[0-9a-f]{24}$/;

export async function accountIdPublico(tenantId: string): Promise<string> {
  return `${PREFIXO}${await seatRef(tenantId)}`;
}

export type ContaPedida =
  | { accountId: string | null }
  | { error: 'invalid_account_id' | 'account_id_conflict'; status: 400 }
  | { error: 'body_too_large' | 'attachments_too_large'; status: 413; max_bytes: number };

// O corpo lido aqui volta para o cache do Hono: a rota le de novo (lerBytes
// cai no cache quando o stream ja foi consumido; c.req.json converte dele).
function guardaNoCache(c: Ctx, bytes: Uint8Array): void {
  const req = c.req as unknown as { bodyCache: Record<string, Promise<unknown>> };
  const copia = bytes.slice().buffer;
  req.bodyCache.arrayBuffer = Promise.resolve(copia);
}

// Le o `account_id` do request: query string (qualquer metodo), campo do
// corpo JSON ou campo do multipart. O corpo e lido UMA vez, com o mesmo teto
// das rotas (lib/entrada, revisao F2.41: corpo perto dos 100 MB da plataforma
// em memoria derrubaria o isolate), antes do rate limit e de qualquer parse.
// Corpo acima do teto responde 413 aqui mesmo. Corpo ilegivel nao e erro
// aqui: a rota responde invalid_json/invalid_body como antes.
export async function lerContaPedida(c: Ctx): Promise<ContaPedida> {
  const valores: unknown[] = [];
  const naQuery = c.req.query('account_id');
  if (naQuery !== undefined) valores.push(naQuery);

  const tipo = (c.req.header('content-type') ?? '').toLowerCase();
  const json = tipo.startsWith('application/json');
  const multipart = tipo.startsWith('multipart/form-data');
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && (json || multipart)) {
    const max = json ? MAX_BYTES_JSON : MAX_BYTES_ANEXOS + MAX_BYTES_JSON;
    const bytes = await lerBytes(c, max);
    if (bytes === 'grande') {
      return json
        ? { error: 'body_too_large', status: 413, max_bytes: MAX_BYTES_JSON }
        : { error: 'attachments_too_large', status: 413, max_bytes: MAX_BYTES_ANEXOS };
    }
    if (bytes !== 'ilegivel') {
      guardaNoCache(c, bytes);
      try {
        if (json) {
          const corpo: unknown = JSON.parse(new TextDecoder().decode(bytes));
          if (corpo && typeof corpo === 'object' && !Array.isArray(corpo) && 'account_id' in corpo) {
            valores.push((corpo as Record<string, unknown>).account_id);
          }
        } else {
          // Header original: o boundary do multipart diferencia maiuscula.
          const form = await new Response(bytes, {
            headers: { 'content-type': c.req.header('content-type') ?? '' },
          }).formData();
          const campo = form.get('account_id');
          if (campo !== null) valores.push(campo);
        }
      } catch {
        // a rota decide o que fazer com corpo invalido
      }
    }
  }

  if (valores.length === 0) return { accountId: null };
  if (valores.some((v) => typeof v !== 'string')) {
    return { error: 'invalid_account_id', status: 400 };
  }
  const distintos = new Set(valores as string[]);
  if (distintos.size > 1) {
    return { error: 'account_id_conflict', status: 400 };
  }
  const [valor] = distintos;
  // String vazia = campo presente sem escolha: segue a conta da chave.
  return { accountId: valor ? valor : null };
}

// Tenant da conta pedida, se ela for do grupo da chave. `null` = nao existe
// ou nao e deste cliente (a rota nao distingue um caso do outro).
export async function tenantDaContaPedida(
  env: Env,
  keyTenantId: string,
  accountId: string,
): Promise<string | null> {
  if (!FORMATO.test(accountId)) return null;
  if ((await accountIdPublico(keyTenantId)) === accountId) return keyTenantId;
  const grupo = await tenantsDoGrupo(env, keyTenantId);
  for (const t of grupo) {
    if ((await accountIdPublico(t.id)) === accountId) return t.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /v1/accounts: as contas que a chave alcanca, com o id que o cliente
// passa nas chamadas. Nada da origem sai daqui (nem o id dela, nem o nome
// interno do tenant): so o rotulo que o proprio LinkedIn confirmou.
// ---------------------------------------------------------------------------

export type EstadoConta = 'active' | 'paused' | 'disconnected' | 'none';

export interface ContaDoGrupo {
  account_id: string;
  name: string | null;
  status: EstadoConta;
  connected_at: string | null;
  is_key_account: boolean;
}

interface LinhaConta {
  tenant_id: string;
  status: string;
  label: string | null;
  created_at: string;
}

function estado(linhas: LinhaConta[]): EstadoConta {
  if (linhas.some((l) => l.status === 'active')) return 'active';
  if (linhas.some((l) => l.status === 'paused')) return 'paused';
  if (linhas.some((l) => l.status === 'disconnected')) return 'disconnected';
  return 'none';
}

export async function contasDoGrupo(env: Env, keyTenantId: string): Promise<ContaDoGrupo[]> {
  const tenants = await tenantsDoGrupo(env, keyTenantId);
  if (tenants.length === 0) return [];
  const ids = tenants.map((t) => t.id);
  const linhas = await supabaseSelect<LinhaConta>(env, 'connected_accounts', {
    tenant_id: `in.(${ids.join(',')})`,
    provider: 'eq.linkedin',
    select: 'tenant_id,status,label,created_at',
    order: 'created_at.desc',
  });
  return Promise.all(
    tenants.map(async (t) => {
      const doTenant = linhas.filter((l) => l.tenant_id === t.id);
      const status = estado(doTenant);
      // A linha que decide o estado e a que aparece: ativa primeiro, senao a
      // mais recente (a lista ja vem por created_at desc).
      const principal =
        doTenant.find((l) => l.status === 'active') ??
        doTenant.find((l) => l.status === status) ??
        doTenant[0];
      return {
        account_id: await accountIdPublico(t.id),
        name: principal?.label ?? null,
        status,
        connected_at: principal?.created_at ?? null,
        is_key_account: t.id === keyTenantId,
      };
    }),
  );
}
