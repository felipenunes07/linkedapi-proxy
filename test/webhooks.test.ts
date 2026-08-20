import { describe, it, expect, vi, afterEach } from 'vitest';
import { deliverWebhook } from '../src/lib/webhooks';

// Entrega assinada de webhook ao cliente (fase 2): assinatura HMAC verificavel
// no estilo timestamp.corpo, e ate 3 tentativas.

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

afterEach(() => {
  vi.useRealTimers();
});

describe('deliverWebhook', () => {
  it('assina timestamp.corpo com o secret e o cliente consegue validar', async () => {
    let captured: Request | null = null;
    const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(url as string, init);
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const delivered = await deliverWebhook(
      'https://cliente.example/hook',
      'segredo-do-tenant',
      'message.received',
      { chat_id: 'c1' },
      fetchFn,
    );
    expect(delivered).toBe(true);

    const req = captured as unknown as Request;
    expect(req.headers.get('x-webhook-event')).toBe('message.received');
    const timestamp = req.headers.get('x-webhook-timestamp')!;
    const signature = req.headers.get('x-webhook-signature')!;
    const body = await req.text();
    expect(JSON.parse(body)).toEqual({ type: 'message.received', data: { chat_id: 'c1' } });

    // O cliente recomputa a assinatura com o mesmo secret e tem que bater.
    const expected = await hmacHex('segredo-do-tenant', `${timestamp}.${body}`);
    expect(signature).toBe(`sha256=${expected}`);
  });

  it('tenta de novo apos falha e retorna true quando uma tentativa passa', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 500 }))
      .mockRejectedValueOnce(new Error('rede caiu'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const delivered = await deliverWebhook(
      'https://cliente.example/hook',
      's',
      'e',
      {},
      fetchFn as unknown as typeof fetch,
      [0, 0, 0], // sem espera em teste; os delays reais sao o default da lib
    );
    expect(delivered).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('desiste depois de 3 tentativas e retorna false', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('err', { status: 500 }));
    const delivered = await deliverWebhook(
      'https://cliente.example/hook',
      's',
      'e',
      {},
      fetchFn as unknown as typeof fetch,
      [0, 0, 0],
    );
    expect(delivered).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});
