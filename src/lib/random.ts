// Geracao de segredos no Worker (Web Crypto): 32 bytes aleatorios (256 bits)
// em hex, mesma entropia das chaves emitidas pelos scripts Node. E a premissa
// que permite SHA-256 puro no hash (ver src/lib/hash.ts).
export function randomHex32(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
