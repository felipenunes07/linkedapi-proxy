import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { supabaseInsert, supabaseUpdate } from '../lib/supabase';
import { hashApiKey } from '../lib/hash';
import { randomHex32 } from '../lib/random';
import { deleteLegacy, getLegacyUrl, putLegacy } from '../lib/clientWebhooks';

// Self-service do tenant (fase 2). Montado DENTRO de /v1, ou seja, atras do
// authMiddleware: quem chama ja provou posse de uma chave ativa. Nenhum
// tenant_id vem do request; tudo sai do tenant resolvido.
//
//   POST   /v1/keys/rotate  troca a chave usada na chamada por uma nova
//   PUT    /v1/webhook      registra url https + gera secret de assinatura
//   GET    /v1/webhook      mostra a configuracao (nunca o secret)
//   DELETE /v1/webhook      remove url e secret
//
// Desde o F2.43 a conta pode ter varios webhooks, por evento (painel). As
// tres rotas acima seguem valendo e operam no webhook mais antigo, o
// "principal" (ver lib/clientWebhooks.ts).

export const selfservice = new Hono<{ Bindings: Env; Variables: Variables }>();

// Rotacao de chave: cria uma chave nova para o tenant e revoga A CHAVE USADA
// NESTA CHAMADA (nunca outra: se o tenant tiver mais chaves, elas continuam).
// O valor novo aparece UMA vez, na resposta; guardamos so o hash.
//
// Com `account_id` de outra conta do grupo (F2.42), continua sendo a chave
// USADA que roda: tudo aqui e do tenant dono da chave (keyTenantId), nunca da
// conta escolhida.
selfservice.post('/keys/rotate', async (c) => {
  const tenant = c.get('tenant');
  const donoDaChave = tenant.keyTenantId;

  const apiKey = `lk_live_${randomHex32()}`;
  const keyHash = await hashApiKey(apiKey);

  // Ordem importa: cria a nova ANTES de revogar a atual. Se a criacao falhar,
  // a chave velha continua valida (nunca deixar o tenant sem chave).
  await supabaseInsert(c.env, 'api_keys', {
    tenant_id: donoDaChave,
    key_hash: keyHash,
    status: 'active',
  });
  await supabaseUpdate(
    c.env,
    'api_keys',
    { key_hash: `eq.${tenant.keyHash}`, tenant_id: `eq.${donoDaChave}` },
    { status: 'revoked' },
  );

  // Resposta carrega segredo: nunca cachear.
  c.header('Cache-Control', 'no-store');
  return c.json({
    ok: true,
    data: {
      api_key: apiKey,
      note: 'Guarde agora: este valor nao sera exibido de novo. A chave usada nesta chamada foi revogada.',
    },
  });
});

// Validacao do destino do webhook. O Worker faz POST nessa URL a cada evento:
// bloquear credencial embutida, porta fora do padrao, IP literal e nomes
// internos reduz o uso do proxy como SSRF/amplificador (o resto da defesa e o
// redirect:manual + timeout na entrega, ver lib/webhooks.ts).
export function isValidWebhookUrl(url: string): boolean {
  if (url.length > 500) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== '443') return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.internal') || host.endsWith('.local')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal
  if (host.includes(':') || host.startsWith('[')) return false; // IPv6 literal
  if (!host.includes('.')) return false; // nomes sem dominio (intranet)
  return true;
}

// Registrar/atualizar o webhook do tenant. So https. O secret e gerado por
// nos (256 bits) e mostrado UMA vez; e com ele que validamos a assinatura
// X-Webhook-Signature dos eventos.
selfservice.put('/webhook', async (c) => {
  const tenant = c.get('tenant');

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const { url } = (body ?? {}) as Record<string, unknown>;
  if (typeof url !== 'string' || !isValidWebhookUrl(url)) {
    return c.json({ error: 'invalid_url' }, 400);
  }

  const secret = await putLegacy(c.env, tenant.tenantId, url);

  // Resposta carrega segredo: nunca cachear.
  c.header('Cache-Control', 'no-store');
  return c.json({
    ok: true,
    data: {
      url,
      secret,
      note: 'Guarde o secret agora: ele assina cada evento (X-Webhook-Signature) e nao sera exibido de novo.',
    },
  });
});

selfservice.get('/webhook', async (c) => {
  const tenant = c.get('tenant');
  const url = await getLegacyUrl(c.env, tenant.tenantId);
  return c.json({ ok: true, data: { url, configured: url !== null } });
});

selfservice.delete('/webhook', async (c) => {
  const tenant = c.get('tenant');
  await deleteLegacy(c.env, tenant.tenantId);
  return c.json({ ok: true, data: { configured: false } });
});
