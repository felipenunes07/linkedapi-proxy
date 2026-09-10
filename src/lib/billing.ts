import type { Env } from '../types';
import { supabaseSelect } from './supabase';

// Status que uma conta LinkedIn assume quando volta a funcionar (sessao
// restabelecida na origem ou reconexao pelo wizard). Review F2.25, #3: a pausa
// por inadimplencia so alcanca contas `active`; uma conta que estava
// desconectada no dia do atraso escaparia dela ao reconectar. Assinatura em
// atraso = `paused`. Sem vinculo de cobranca (tenant do operador) ou em dia =
// `active`.
export async function statusAoReativar(env: Env, tenantId: string): Promise<'active' | 'paused'> {
  const rows = await supabaseSelect<{ status: string }>(env, 'billing_subscriptions', {
    tenant_id: `eq.${tenantId}`,
    select: 'status',
    limit: '1',
  });
  return rows[0]?.status === 'overdue' ? 'paused' : 'active';
}
