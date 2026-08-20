// Setup do deploy em um comando (rodar DEPOIS de `npx wrangler login`).
//
//   npm run deploy:setup
//
// Faz o que o roteiro do HANDOFF pede, sem passos manuais:
//   1. confere que o wrangler esta autenticado;
//   2. cria o KV namespace RATE_LIMIT (se o wrangler.jsonc ainda tem o
//      placeholder) e cola o id no wrangler.jsonc;
//   3. sobe os 4 secrets lendo do .dev.vars (via stdin; nunca em argv/log).
// Depois: npm run deploy, e preencher PUBLIC_BASE_URL com a URL resultante.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadEnv, fail } from './env.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wranglerJsoncPath = resolve(__dirname, '..', 'wrangler.jsonc');
const PLACEHOLDER = 'REPLACE_WITH_KV_NAMESPACE_ID';

const SECRET_NAMES = [
  'UNIPILE_DSN',
  'UNIPILE_MASTER_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

function runWrangler(args: string[], input?: string): { ok: boolean; out: string } {
  const res = spawnSync('npx', ['wrangler', ...args], {
    input,
    encoding: 'utf8',
    shell: process.platform === 'win32', // npx.cmd no Windows
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { ok: res.status === 0, out };
}

function step1Login(): void {
  const { ok, out } = runWrangler(['whoami']);
  if (!ok || out.includes('not authenticated')) {
    fail('wrangler nao autenticado. Rode antes: npx wrangler login');
  }
  console.log('1. wrangler autenticado, OK');
}

function step2Kv(): void {
  const jsonc = readFileSync(wranglerJsoncPath, 'utf8');
  if (!jsonc.includes(PLACEHOLDER)) {
    console.log('2. KV namespace ja configurado no wrangler.jsonc, pulando');
    return;
  }
  console.log('2. criando KV namespace RATE_LIMIT...');
  const { ok, out } = runWrangler(['kv', 'namespace', 'create', 'RATE_LIMIT']);
  const namespaceId = out.match(/id\s*=\s*"([0-9a-f]{32})"/)?.[1];
  if (!ok || !namespaceId) {
    // Sem colar a saida crua inteira: pode ter detalhe de conta. So a dica.
    fail(
      'Nao consegui criar/ler o id do namespace. Rode na mao: npx wrangler kv namespace create RATE_LIMIT e cole o id no wrangler.jsonc.',
    );
  }
  writeFileSync(
    wranglerJsoncPath,
    jsonc.replace(PLACEHOLDER, namespaceId),
    'utf8',
  );
  console.log(`   id ${namespaceId} gravado no wrangler.jsonc`);
}

function step3Secrets(): void {
  console.log('3. subindo secrets (valores lidos do .dev.vars, nunca logados)...');
  for (const name of SECRET_NAMES) {
    const value = loadEnv(name); // falha cedo se faltar no .dev.vars
    const { ok } = runWrangler(['secret', 'put', name], value);
    if (!ok) {
      fail(`Falha ao subir o secret ${name}. Rode na mao: npx wrangler secret put ${name}`);
    }
    console.log(`   ${name}: OK`);
  }
}

function main(): void {
  step1Login();
  step2Kv();
  step3Secrets();
  console.log('');
  console.log('Pronto. Proximos passos:');
  console.log('  npm run deploy');
  console.log('  curl https://<url-do-deploy>/health   (espera {"ok":true})');
  console.log('  preencher PUBLIC_BASE_URL no .dev.vars com a URL do deploy');
  console.log('  trocar o server do openapi.json pela mesma URL');
}

main();
