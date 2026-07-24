import { describe, it, expect } from 'vitest';
import { hashApiKey } from '../src/lib/hash';
import { hashApiKey as hashFromTenants } from '../src/lib/tenants';

// Marco 5: o script de emissao (scripts/keys.ts) e o Worker (auth) TEM que
// hashear identico, senao a chave emitida nunca casa na autenticacao. Ambos
// importam de src/lib/hash.ts. Este teste trava esse contrato.

describe('hashApiKey (compartilhado Worker/script)', () => {
  it('e SHA-256 hex conhecido (vetor fixo)', async () => {
    // SHA-256 de "lk_live_test" (UTF-8) em hex, valor de referencia estavel.
    const digest = await hashApiKey('lk_live_test');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(
      '59e73d5cc344360e378e858bd9f93e7d11536c20991edd1afa0a843c8aa88f70',
    );
  });

  it('tenants.ts reexporta exatamente o mesmo hash de hash.ts', async () => {
    expect(hashFromTenants).toBe(hashApiKey);
    const a = await hashApiKey('lk_live_alpha');
    const b = await hashFromTenants('lk_live_alpha');
    expect(a).toBe(b);
  });
});
