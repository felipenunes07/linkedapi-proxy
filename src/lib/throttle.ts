// Contadores de tentativa por janela diaria (UTC) em KV, usados pelas rotas
// publicas (/hooks/*). Read-modify-write como o rate limit: overshoot leve sob
// concorrencia e aceitavel, o teto e protecao de custo/abuso, nao contagem
// exata. TTL de 2 dias cobre a janela e deixa o KV limpar sozinho.

const ATTEMPT_TTL_SECONDS = 2 * 24 * 60 * 60;

export function attemptKey(scope: string, id: string): string {
  const day = new Date().toISOString().slice(0, 10);
  return `throttle:${scope}:${id}:${day}`;
}

export async function bumpAttempts(
  kv: KVNamespace,
  key: string,
): Promise<number> {
  const current = Number((await kv.get(key)) ?? '0') + 1;
  await kv.put(key, String(current), { expirationTtl: ATTEMPT_TTL_SECONDS });
  return current;
}
