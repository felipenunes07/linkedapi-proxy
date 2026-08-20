// Webhooks assinados para o cliente (fase 2).
//
// Cada tenant pode registrar UMA url https (tenants.webhook_url) com um secret
// gerado por nos (tenants.webhook_secret). Todo evento sai assinado com
// HMAC-SHA256 no estilo timestamp.corpo, para o cliente validar origem e
// rejeitar replay:
//   X-Webhook-Timestamp: <unix segundos>
//   X-Webhook-Signature: sha256=<hex de HMAC(secret, `${timestamp}.${corpo}`)>
//   X-Webhook-Event: <tipo>
//
// Entrega best-effort com ate 3 tentativas (0s, 2s, 5s), sempre via
// fireAndForget: a entrega NUNCA atrasa a resposta de quem originou o evento.
// Fila duravel com retry longo fica para quando houver Queues (pendencias).

const RETRY_DELAYS_MS = [0, 2000, 5000];

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Entrega um evento ao webhook do tenant. Retorna true se alguma tentativa
// recebeu 2xx. `fetchFn` e `delaysMs` sao injetaveis para teste.
export async function deliverWebhook(
  url: string,
  secret: string,
  eventType: string,
  payload: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
  delaysMs: readonly number[] = RETRY_DELAYS_MS,
): Promise<boolean> {
  const body = JSON.stringify({ type: eventType, data: payload });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await hmacHex(secret, `${timestamp}.${body}`);

  for (const [attempt, delay] of delaysMs.entries()) {
    if (delay > 0) {
      await sleep(delay);
    }
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-event': eventType,
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature': `sha256=${signature}`,
        },
        body,
        // redirect manual: um 302 para http:// ou IP interno NAO e seguido
        // (o 3xx cai no !res.ok e vira retry/falha). Timeout: endpoint lento
        // do cliente nao segura o waitUntil.
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        return true;
      }
    } catch {
      // Rede falhou/timeout: tenta de novo (ate o teto de tentativas).
    }
    void attempt;
  }
  return false;
}
