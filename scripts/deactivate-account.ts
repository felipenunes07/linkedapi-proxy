// Desativa (status=disconnected) uma linha de connected_accounts pelo
// unipile_account_id. Complemento operacional do account:link para trocar a
// conta de um tenant mantendo trilha (nunca deleta, PRD regra de billing).
//
//   node scripts/deactivate-account.ts <unipile_account_id>
import { loadEnv, fail } from './env.ts';

async function main(): Promise<void> {
  const [unipileAccountId] = process.argv.slice(2);
  if (!unipileAccountId) {
    fail('uso: node scripts/deactivate-account.ts <unipile_account_id>');
  }

  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');

  const res = await fetch(
    `${supabaseUrl}/rest/v1/connected_accounts?unipile_account_id=eq.${encodeURIComponent(unipileAccountId)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: serviceRole,
        authorization: `Bearer ${serviceRole}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      body: JSON.stringify({ status: 'disconnected' }),
    },
  );
  if (!res.ok) {
    fail(`Falha ao desativar (HTTP ${res.status}).`);
  }
  const rows = (await res.json()) as { tenant_id: string; status: string }[];
  if (rows.length === 0) {
    fail(`Nenhuma linha com unipile_account_id=${unipileAccountId}.`);
  }
  for (const r of rows) {
    console.log(`conta ${unipileAccountId}: tenant ${r.tenant_id} -> ${r.status}`);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
