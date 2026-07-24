// Helpers de teste. KV em memoria para exercitar o rate limiter sem rede nem
// binding real do Cloudflare. Implementa so o que o middleware usa (get/put).
export function memoryKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}
