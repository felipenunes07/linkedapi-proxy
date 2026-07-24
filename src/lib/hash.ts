// Hash da API key, COMPARTILHADO entre o Worker e o script de emissao de chave
// (scripts/keys.ts). IMPORTANT: os dois lados TEM que hashear identico, senao a
// chave emitida pelo script nunca casa com o hash que o Worker calcula na
// autenticacao. Por isso mora aqui, num lugar so.
//
// Guardamos apenas o hash; comparamos por hash. A chave em claro tem alta
// entropia (gerada aleatoriamente na criacao), entao SHA-256 e adequado. Se um
// dia a chave passar a ter baixa entropia, trocar por HMAC com salt do servidor.
//
// Usa Web Crypto (crypto.subtle), disponivel tanto no Workers quanto no Node
// (globalThis.crypto), para que o algoritmo seja literalmente o mesmo binario de
// hash nos dois ambientes.
export async function hashApiKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
