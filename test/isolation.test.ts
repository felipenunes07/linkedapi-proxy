import { describe, it, expect } from 'vitest';
import app from '../src/index';

// O teste que prova o negocio (PRD, Marco 2): isolamento multi-tenant.
// A chave do tenant A nunca age pela conta do tenant B, nem passando o
// account_id de B no request. Implementar de verdade no Marco 2, com seed de
// dois tenants. Por ora, esqueleto marcado como pendente.

describe('isolamento multi-tenant', () => {
  it('responde no /health (fumaça: app monta)', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('rejeita request sem X-API-KEY com 401', async () => {
    const res = await app.request('/v1/messages', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it.todo(
    'chave A NAO age pela conta de B mesmo passando account_id de B no corpo',
  );

  it.todo('chave A age pela conta de A; chave B age pela conta de B');
});
