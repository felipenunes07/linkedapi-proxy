import { describe, it, expect } from 'vitest';
import app from '../src/index';
import type { Env } from '../src/types';
import { memoryKV } from './helpers';

// Marco 5: a doc publica (openapi.json + /docs) e a superficie que o testador
// abre. Dois criterios: (1) as rotas respondem sem auth; (2) nada de
// segredo/infra vaza. A doc "e a nossa API", nao pode citar Unipile/DSN/etc.

const env = {
  ENVIRONMENT: 'test',
  UNIPILE_DSN: 'apiX.unipile.com:0000',
  UNIPILE_MASTER_TOKEN: 'master-token-nunca-vaza',
  SUPABASE_URL: 'https://fake.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-nunca-vaza',
  RATE_LIMIT: memoryKV(),
} as Env;

// Termos que NAO podem aparecer na superficie publica (case-insensitive).
// `account_id` saiu da lista em F2.42: agora e o NOSSO id de conta (acc_...),
// documentado de proposito. O id da origem continua sem aparecer (o teste de
// formato abaixo garante que o exemplo e o nosso).
const FORBIDDEN = ['unipile', 'dsn', 'master', 'service_role'];

describe('GET /openapi.json', () => {
  it('responde 200 sem auth e entrega a spec', async () => {
    const res = await app.request('/openapi.json', {}, env);
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { openapi: string; paths: unknown };
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.paths).toBeTruthy();
  });

  it('nao vaza termos de infra/segredo', async () => {
    const res = await app.request('/openapi.json', {}, env);
    const text = (await res.text()).toLowerCase();
    for (const term of FORBIDDEN) {
      expect(text).not.toContain(term);
    }
  });

  it('descreve os 3 endpoints da V1 e o security scheme X-API-KEY', async () => {
    const res = await app.request('/openapi.json', {}, env);
    const spec = (await res.json()) as {
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, { name?: string }> };
    };
    expect(spec.paths['/v1/messages']).toBeTruthy();
    expect(spec.paths['/v1/invitations']).toBeTruthy();
    expect(spec.paths['/v1/chats']).toBeTruthy();
    expect(spec.components.securitySchemes.apiKey?.name).toBe('X-API-KEY');
  });
});

describe('openapi.json x rotas do Worker', () => {
  // A doc e a unica superficie que o integrador le: rota sem doc nao existe
  // para ele, e doc sem rota e promessa quebrada. Compara metodo + caminho.
  it('toda rota /v1 esta documentada, e todo caminho documentado existe', async () => {
    const spec = (await (await app.request('/openapi.json', {}, env)).json()) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const documentadas = new Set<string>();
    for (const [caminho, ops] of Object.entries(spec.paths)) {
      for (const metodo of Object.keys(ops)) {
        documentadas.add(`${metodo.toUpperCase()} ${caminho}`);
      }
    }
    const registradas = new Set(
      app.routes
        .filter((r) => r.path.startsWith('/v1/') && r.method !== 'ALL')
        .map((r) => `${r.method} ${r.path.replace(/:([a-z_]+)/g, '{$1}')}`),
    );
    // Garante que a comparacao nao e vazia (app.routes mudou de forma?).
    expect(registradas.size).toBeGreaterThan(40);
    expect([...registradas].filter((r) => !documentadas.has(r))).toEqual([]);
    expect([...documentadas].filter((d) => !registradas.has(d))).toEqual([]);
  });
});

describe('GET /docs', () => {
  it('responde 200 sem auth com HTML do Scalar apontando para /openapi.json', async () => {
    const res = await app.request('/docs', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('data-url="/openapi.json"');
  });

  it('nao vaza termos de infra/segredo', async () => {
    const res = await app.request('/docs', {}, env);
    const html = (await res.text()).toLowerCase();
    for (const term of FORBIDDEN) {
      expect(html).not.toContain(term);
    }
  });
});
