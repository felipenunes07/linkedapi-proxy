// Registro dos webhooks da origem (fase 2). Script standalone do operador.
//
//   npm run webhook:register -- account-status
//   npm run webhook:register -- messaging
//   npm run webhook:register -- users
//
// Registra na Unipile um webhook apontando para o Worker publico
// ({PUBLIC_BASE_URL}/hooks/account-status, /hooks/message-received ou
// /hooks/relation), com o secret compartilhado no header x-hook-secret. O
// Worker so aceita o hook se o MESMO secret estiver configurado no env dele
// (fail-closed).
//
// F2.43: `messaging` pede TODOS os eventos de mensagem (o cliente escolhe no
// painel quais recebe; o filtro e nosso). Um webhook `messaging` registrado
// antes disso precisa ser apagado no dashboard da Unipile e registrado de novo.
//
// Os secrets (ACCOUNT_STATUS_HOOK_SECRET / MESSAGE_HOOK_SECRET /
// USERS_HOOK_SECRET) vem de
// .dev.vars. Se ainda nao existirem: gere um valor com
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// grave no .dev.vars E em producao (npx wrangler secret put <NOME>), e rode
// este script de novo.
import { loadEnv, fail } from './env.ts';

interface HookConfig {
  source: string;
  path: string;
  secretVar: string;
  name: string;
  // Eventos pedidos a origem. Sem a lista, vale o default da Unipile.
  events?: string[];
}

const HOOKS: Record<string, HookConfig> = {
  'account-status': {
    source: 'account_status',
    path: '/hooks/account-status',
    secretVar: 'ACCOUNT_STATUS_HOOK_SECRET',
    name: 'linkedapi-account-status',
  },
  messaging: {
    source: 'messaging',
    path: '/hooks/message-received',
    secretVar: 'MESSAGE_HOOK_SECRET',
    name: 'linkedapi-message-received',
    events: [
      'message_received',
      'message_read',
      'message_reaction',
      'message_edited',
      'message_deleted',
      'message_delivered',
    ],
  },
  users: {
    source: 'users',
    path: '/hooks/relation',
    secretVar: 'USERS_HOOK_SECRET',
    name: 'linkedapi-new-relation',
    events: ['new_relation'],
  },
};

async function register(kind: string): Promise<void> {
  const config = HOOKS[kind];
  if (!config) {
    fail(`Tipo desconhecido: ${kind}. Use: ${Object.keys(HOOKS).join(' | ')}`);
  }

  const dsn = loadEnv('UNIPILE_DSN');
  const masterToken = loadEnv('UNIPILE_MASTER_TOKEN');
  const publicBaseUrl = loadEnv('PUBLIC_BASE_URL').replace(/\/+$/, '');
  if (!publicBaseUrl.startsWith('https://')) {
    fail('PUBLIC_BASE_URL precisa comecar com https://');
  }
  const secret = loadEnv(config.secretVar);

  const res = await fetch(`https://${dsn}/api/v1/webhooks`, {
    method: 'POST',
    headers: {
      'X-API-KEY': masterToken,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      source: config.source,
      request_url: `${publicBaseUrl}${config.path}`,
      name: config.name,
      ...(config.events ? { events: config.events } : {}),
      headers: [{ key: 'x-hook-secret', value: secret }],
    }),
  });
  if (!res.ok) {
    // Sem corpo cru: pode carregar detalhe de infra.
    fail(`Falha ao registrar o webhook (HTTP ${res.status}).`);
  }
  const data = (await res.json()) as { webhook_id?: string; id?: string };

  console.log('');
  console.log(`Webhook "${kind}" registrado:`);
  console.log(`  destino: ${publicBaseUrl}${config.path}`);
  if (data.webhook_id ?? data.id) {
    console.log(`  id:      ${data.webhook_id ?? data.id}`);
  }
  console.log('');
  console.log(`Confira que ${config.secretVar} tambem esta em producao:`);
  console.log(`  npx wrangler secret put ${config.secretVar}`);
}

async function main(): Promise<void> {
  const [kind] = process.argv.slice(2);
  if (!kind) {
    fail(`uso: npm run webhook:register -- <${Object.keys(HOOKS).join(' | ')}>`);
  }
  await register(kind);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
