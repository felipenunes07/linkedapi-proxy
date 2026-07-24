// Emissao e revogacao de API keys da NOSSA API. Script Node standalone (sem
// Worker): codifica o que ate agora era feito na mao.
//
//   npm run key:issue  -- <tenant_id>   gera lk_live_<hex>, grava SO o hash e
//                                        imprime o valor em claro UMA vez.
//   npm run key:revoke -- <key_id>       PATCH status=revoked (nunca hard-delete;
//                                        mantem a trilha de auditoria).
//
// Regras que este script respeita (CLAUDE.md):
//   - guardamos APENAS o hash da chave; o claro so aparece no stdout, na emissao.
//   - SUPABASE_SERVICE_ROLE_KEY e segredo: lida de .dev.vars/env, nunca logada.
//   - o hash TEM que casar com o do Worker: usamos o MESMO hashApiKey compartilhado.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { hashApiKey } from '../src/lib/hash.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Le SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY. Prioridade: variavel de ambiente
// ja setada; senao, faz parse de .dev.vars (mesmo arquivo do Worker em dev).
// .dev.vars e gitignored; o segredo nunca vai para arquivo versionado nem log.
function loadEnv(name: string): string {
  const fromProcess = process.env[name];
  if (fromProcess && fromProcess.length > 0) {
    return fromProcess;
  }
  const parsed = parseDevVars();
  const value = parsed[name];
  if (!value) {
    fail(
      `Falta ${name}. Defina em .dev.vars (na raiz do projeto) ou como variavel de ambiente.`,
    );
  }
  return value;
}

// Parser minimo de dotenv: linhas KEY=VALUE, ignora comentarios (#) e vazias,
// remove aspas simples/duplas em volta do valor. Suficiente para .dev.vars.
let devVarsCache: Record<string, string> | null = null;
function parseDevVars(): Record<string, string> {
  if (devVarsCache) {
    return devVarsCache;
  }
  const out: Record<string, string> = {};
  const path = resolve(__dirname, '..', '.dev.vars');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    devVarsCache = out;
    return out;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  devVarsCache = out;
  return out;
}

// Headers do PostgREST com a service role (segredo). Nunca logar estes valores.
function supabaseHeaders(serviceRole: string): Record<string, string> {
  return {
    apikey: serviceRole,
    authorization: `Bearer ${serviceRole}`,
    'content-type': 'application/json',
    prefer: 'return=representation',
  };
}

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  status: string;
}

async function issue(tenantId: string): Promise<void> {
  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');

  // Chave em claro: prefixo reconhecivel + 32 bytes aleatorios (256 bits) em hex.
  const apiKey = `lk_live_${randomBytes(32).toString('hex')}`;
  const keyHash = await hashApiKey(apiKey);

  const res = await fetch(`${supabaseUrl}/rest/v1/api_keys`, {
    method: 'POST',
    headers: supabaseHeaders(serviceRole),
    body: JSON.stringify({
      tenant_id: tenantId,
      key_hash: keyHash,
      status: 'active',
    }),
  });

  if (!res.ok) {
    // Nao imprimir o corpo cru sem cuidado: pode carregar detalhe de infra.
    fail(`Falha ao gravar a chave (HTTP ${res.status}). Verifique o tenant_id.`);
  }

  const rows = (await res.json()) as ApiKeyRow[];
  const row = rows[0];
  if (!row) {
    fail('Insercao nao retornou a linha criada.');
  }

  // O valor em claro aparece UMA vez, so aqui no stdout. Nunca e persistido.
  console.log('');
  console.log('Chave criada. Guarde o valor abaixo AGORA, ele nao sera exibido de novo:');
  console.log('');
  console.log(`  API key:   ${apiKey}`);
  console.log(`  key_id:    ${row.id}`);
  console.log(`  tenant_id: ${row.tenant_id}`);
  console.log('');
}

async function revoke(keyId: string): Promise<void> {
  const supabaseUrl = loadEnv('SUPABASE_URL');
  const serviceRole = loadEnv('SUPABASE_SERVICE_ROLE_KEY');

  const url = new URL(`${supabaseUrl}/rest/v1/api_keys`);
  url.searchParams.set('id', `eq.${keyId}`);

  const res = await fetch(url.toString(), {
    method: 'PATCH',
    headers: supabaseHeaders(serviceRole),
    body: JSON.stringify({ status: 'revoked' }),
  });

  if (!res.ok) {
    fail(`Falha ao revogar (HTTP ${res.status}).`);
  }

  const rows = (await res.json()) as ApiKeyRow[];
  const row = rows[0];
  if (!row) {
    fail(`Nenhuma chave com key_id ${keyId}. Nada foi alterado.`);
  }

  console.log(`Chave ${row.id} revogada (status=${row.status}). Nao autentica mais.`);
}

function fail(message: string): never {
  console.error(`erro: ${message}`);
  process.exit(1);
}

function usage(): never {
  console.error('uso:');
  console.error('  npm run key:issue  -- <tenant_id>');
  console.error('  npm run key:revoke -- <key_id>');
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (command === 'issue') {
    if (!arg) {
      fail('key:issue precisa do <tenant_id>.');
    }
    await issue(arg);
  } else if (command === 'revoke') {
    if (!arg) {
      fail('key:revoke precisa do <key_id>.');
    }
    await revoke(arg);
  } else {
    usage();
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
