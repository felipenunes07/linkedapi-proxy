// Prova real da chave (criterio de aceite do Marco 5), automatizada.
//
//   npm run prova:chave -- <tenant_id> [base_url]
//
// Contra o Worker em base_url (default http://localhost:8787, ou seja,
// `npm run dev` rodando ao lado). E real de qualquer jeito: Supabase real +
// Unipile real. Roteiro (HANDOFF): emitir chave -> GET /v1/chats espera 200 ->
// revogar -> repetir espera 401. Sai com codigo 0 (PASS) ou 1 (FAIL).
//
// A chave emitida e temporaria e e revogada ao final; o valor em claro nao e
// impresso (so um prefixo mascarado).
import { randomBytes } from 'node:crypto';
import { hashApiKey } from '../src/lib/hash.ts';
import { loadEnv, fail } from './env.ts';

function supabaseHeaders(serviceRole: string): Record<string, string> {
  return {
    apikey: serviceRole,
    authorization: `Bearer ${serviceRole}`,
    'content-type': 'application/json',
    prefer: 'return=representation',
  };
}

interface ApiKeyRow {
  id: string;
}

async function main(): Promise<void> {
  const [tenantId, baseArg] = process.argv.slice(2);
  if (!tenantId) {
    fail('uso: npm run prova:chave -- <tenant_id> [base_url]');
  }
  const base = (baseArg ?? 'http://localhost:8787').replace(/\/+$/, '');
  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');

  console.log(`Prova real da chave contra ${base} (tenant ${tenantId})`);

  // O Worker esta de pe?
  try {
    const health = await fetch(`${base}/health`);
    if (!health.ok) {
      fail(`/health respondeu ${health.status}. O Worker esta rodando em ${base}?`);
    }
  } catch {
    fail(`Nao alcancei ${base}. Rode "npm run dev" (local) ou confira a URL.`);
  }

  // 1. Emitir chave (mesma logica do key:issue; valor nunca impresso inteiro).
  const apiKey = `lk_live_${randomBytes(32).toString('hex')}`;
  const keyHash = await hashApiKey(apiKey);
  const issueRes = await fetch(`${supabaseUrl}/rest/v1/api_keys`, {
    method: 'POST',
    headers: supabaseHeaders(serviceRole),
    body: JSON.stringify({ tenant_id: tenantId, key_hash: keyHash, status: 'active' }),
  });
  if (!issueRes.ok) {
    fail(`Falha ao emitir a chave (HTTP ${issueRes.status}). Tenant existe?`);
  }
  const keyRow = ((await issueRes.json()) as ApiKeyRow[])[0];
  if (!keyRow) {
    fail('Emissao nao retornou a linha criada.');
  }
  console.log(`1. chave emitida (${apiKey.slice(0, 16)}..., key_id ${keyRow.id})`);

  // 2. Chave ativa deve autenticar: 200.
  const okRes = await fetch(`${base}/v1/chats`, {
    headers: { 'X-API-KEY': apiKey },
  });
  const passo2 = okRes.status === 200;
  console.log(
    `2. GET /v1/chats com a chave: ${okRes.status} ${passo2 ? '(esperado 200, OK)' : '(esperava 200, FALHOU)'}`,
  );
  if (okRes.status === 401) {
    console.log(
      '   Dica: 401 com chave valida = tenant sem connected_account ativa.',
    );
    console.log(
      '   Vincule com: npm run account:link -- <tenant_id> <unipile_account_id>',
    );
  }

  // 3. Revogar.
  const revokeUrl = new URL(`${supabaseUrl}/rest/v1/api_keys`);
  revokeUrl.searchParams.set('id', `eq.${keyRow.id}`);
  const revokeRes = await fetch(revokeUrl.toString(), {
    method: 'PATCH',
    headers: supabaseHeaders(serviceRole),
    body: JSON.stringify({ status: 'revoked' }),
  });
  if (!revokeRes.ok) {
    fail(`Falha ao revogar (HTTP ${revokeRes.status}). Revogue na mao: key_id ${keyRow.id}`);
  }
  console.log(`3. chave revogada (key_id ${keyRow.id})`);

  // 4. Chave revogada nao autentica mais: 401.
  const negRes = await fetch(`${base}/v1/chats`, {
    headers: { 'X-API-KEY': apiKey },
  });
  const passo4 = negRes.status === 401;
  console.log(
    `4. GET /v1/chats apos revogar: ${negRes.status} ${passo4 ? '(esperado 401, OK)' : '(esperava 401, FALHOU)'}`,
  );

  console.log('');
  if (passo2 && passo4) {
    console.log('PASS: emissao cria chave que autentica; revogacao invalida.');
    console.log('Criterio de aceite do Marco 5 (prova real) cumprido.');
  } else {
    fail('FAIL: a prova nao fechou. Veja os passos acima.');
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
