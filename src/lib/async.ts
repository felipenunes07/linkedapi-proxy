import type { Context } from 'hono';

// Trabalho best-effort pos-resposta (uso persistente, last_used_at, entrega de
// webhook): NUNCA pode atrasar nem derrubar a resposta ao cliente.
//
// Em producao usa executionCtx.waitUntil (o Worker mantem a promise viva apos
// responder). Em teste/ambientes sem executionCtx, apenas dispara. Qualquer
// erro e engolido de proposito: quem chama decide se o dado e critico (se for,
// nao use isto).
export function fireAndForget(
  c: Context,
  work: () => Promise<unknown>,
): void {
  let promise: Promise<unknown>;
  try {
    promise = work();
  } catch {
    return;
  }
  const swallowed = promise.catch(() => {});
  try {
    c.executionCtx.waitUntil(swallowed);
  } catch {
    void swallowed;
  }
}
