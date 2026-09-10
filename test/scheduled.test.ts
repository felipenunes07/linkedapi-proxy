import { describe, it, expect, vi } from 'vitest';
import type { Env } from '../src/types';

// Handler `scheduled` do Worker (cron do wrangler.jsonc): chama a faxina e, se
// ela falhar, deixa o motivo no log (so o codigo interno, sem segredo).

vi.mock('../src/lib/limpeza', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/limpeza')>()),
  limparCheckoutsAbandonados: vi.fn(async () => ({ removidos: 0, mantidos: 0 })),
}));

import app from '../src/index';
import { limparCheckoutsAbandonados } from '../src/lib/limpeza';

async function rodarCron(env: Env) {
  const tarefas: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      tarefas.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  await app.scheduled({} as ScheduledController, env, ctx);
  await Promise.all(tarefas);
}

describe('cron do Worker', () => {
  it('roda a faxina de checkouts abandonados', async () => {
    const env = { ASAAS_API_KEY: 'k' } as Env;
    await rodarCron(env);
    expect(limparCheckoutsAbandonados).toHaveBeenCalledWith(env);
  });

  it('falha da faxina fica no log com o motivo, sem derrubar o cron', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(limparCheckoutsAbandonados).mockRejectedValueOnce(
      new Error('supabase_select_failed:503'),
    );
    await rodarCron({} as Env);
    expect(errSpy).toHaveBeenCalledWith('limpeza_falhou: supabase_select_failed:503');
    errSpy.mockRestore();
  });
});
