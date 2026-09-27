// Cursor de paginacao dos chats (achado E2E de 2026-09-13).
//
// O cursor que a origem devolve e base64 de um JSON que carrega o
// `account_id` dentro. Isso quebrava a regra inviolavel #1 por dois lados:
//
//   1. SAIDA: devolvido como veio, entrega ao cliente um identificador da
//      infraestrutura (o mesmo motivo da whitelist do resto da resposta).
//   2. ENTRADA: repassado como veio, o account_id DE DENTRO DO CURSOR vence o
//      que injetamos no query string. Confirmado no ar: com a chave do tenant
//      A e um cursor com a conta do tenant B, a origem devolveu os chats do B.
//      Ou seja, o account_id voltava a ser escolhido pelo cliente.
//
// A correcao trata o cursor como o que ele deve ser: opaco. Sai sem conta e
// volta sempre com a NOSSA, seja qual for a que o cliente mandou.
//
// Fail-closed: cursor que nao decodifica nao vira requisicao (400). Todo
// cursor legitimo nasce aqui, entao so o forjado (ou corrompido) cai nesse
// caminho.

const CHAVE_CONTA = 'account_id';

function decodifica(cursor: string): Record<string, unknown> | null {
  try {
    const json = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const valor: unknown = JSON.parse(json);
    return valor && typeof valor === 'object' && !Array.isArray(valor)
      ? (valor as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function codifica(objeto: Record<string, unknown>): string | null {
  try {
    return btoa(JSON.stringify(objeto));
  } catch {
    return null;
  }
}

// Cursor que vai para o cliente: sem a conta da origem. Se nao der para
// decodificar, NAO devolve cursor: melhor a paginacao acabar do que vazar um
// formato que nao sabemos ler.
export function cursorParaCliente(cursor: string | null): string | null {
  if (!cursor) return null;
  const objeto = decodifica(cursor);
  if (!objeto) return null;
  delete objeto[CHAVE_CONTA];
  return codifica(objeto);
}

// Cursor que vai para a origem: sempre com a conta resolvida no servidor, por
// cima do que veio do cliente. `null` = cursor invalido, a rota responde 400.
export function cursorParaOrigem(cursor: string, accountId: string): string | null {
  const objeto = decodifica(cursor);
  if (!objeto) return null;
  objeto[CHAVE_CONTA] = [accountId];
  return codifica(objeto);
}

// ---------------------------------------------------------------------------
// Cursor lacrado (F2.41), usado por TODAS as listas novas.
//
// A sondagem da origem mostrou que o formato do cursor muda de rota para rota:
// o de conversas e o de busca carregam a conta dentro, o de mensagens carrega
// o chat_id, o de conexoes so um indice. Reescrever campo a campo (como acima)
// exigiria conhecer cada formato e acompanhar cada mudanca. Em vez disso o
// cursor da origem viaja CIFRADO (AES-GCM) junto com a conta do tenant e o
// escopo da rota:
//
//   - o cliente nao le nada de infraestrutura (nem conta, nem formato);
//   - cursor adulterado nao decifra (GCM autentica) e vira 400;
//   - cursor de outro tenant (ou de outra rota, ou de outro chat) decifra, mas
//     a conta/escopo nao batem, e vira 400: ninguem pagina a lista de outro.
//
// Chave derivada do master token por HKDF com rotulo proprio: nao ha segredo
// novo para configurar, e o token em si nunca e usado como chave direta.
// Trocar o master token so invalida cursores em voo (a lista recomeca).

const ROTULO_CHAVE = 'playbook-api/cursor/v1';
// Teto do cursor que o cliente manda de volta (antes de decifrar). O da
// busca carrega a consulta inteira, entao cabe folga; o lacre nunca
// devolve cursor maior que isto (seria recusado na volta).
const MAX_CURSOR = 16384;
const chavesCache = new Map<string, Promise<CryptoKey>>();

function derivaChave(segredo: string): Promise<CryptoKey> {
  let chave = chavesCache.get(segredo);
  if (!chave) {
    const enc = new TextEncoder();
    chave = crypto.subtle
      .importKey('raw', enc.encode(segredo), 'HKDF', false, ['deriveKey'])
      .then((base) =>
        crypto.subtle.deriveKey(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: enc.encode(ROTULO_CHAVE),
            info: enc.encode('aes-gcm'),
          },
          base,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        ),
      );
    chavesCache.set(segredo, chave);
  }
  return chave;
}

function paraBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deBase64Url(texto: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(texto)) return null;
  try {
    const bin = atob(texto.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

interface CursorLacrado {
  a: string; // conta do tenant
  e: string; // escopo (rota + recurso)
  c: string; // cursor da origem, como veio
}

// Cursor da origem -> cursor que o cliente recebe. `null` quando nao ha
// proxima pagina.
export async function selaCursor(
  segredo: string,
  accountId: string,
  escopo: string,
  cursorOrigem: string | null,
): Promise<string | null> {
  if (!cursorOrigem) return null;
  const chave = await derivaChave(segredo);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const carga: CursorLacrado = { a: accountId, e: escopo, c: cursorOrigem };
  const cifrado = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      chave,
      new TextEncoder().encode(JSON.stringify(carga)),
    ),
  );
  const saida = new Uint8Array(iv.length + cifrado.length);
  saida.set(iv, 0);
  saida.set(cifrado, iv.length);
  const cursor = paraBase64Url(saida);
  if (cursor.length > MAX_CURSOR) {
    // Nao ha como paginar alem daqui sem quebrar o teto: melhor a lista
    // acabar com sinal para o operador do que devolver cursor morto.
    console.warn(`cursor_grande_demais: escopo=${escopo.split(':')[0]}`);
    return null;
  }
  return cursor;
}

// Cursor do cliente -> cursor da origem. `null` = invalido (adulterado, de
// outra conta ou de outra rota): a rota responde 400 invalid_cursor e a
// origem nem e chamada.
export async function abreCursor(
  segredo: string,
  accountId: string,
  escopo: string,
  cursorCliente: string,
): Promise<string | null> {
  if (cursorCliente.length > MAX_CURSOR) return null;
  const bytes = deBase64Url(cursorCliente);
  if (!bytes || bytes.length < 13) return null;
  try {
    const chave = await derivaChave(segredo);
    const claro = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      chave,
      bytes.slice(12),
    );
    const carga = JSON.parse(new TextDecoder().decode(claro)) as Partial<CursorLacrado>;
    if (carga.a !== accountId || carga.e !== escopo || typeof carga.c !== 'string') {
      return null;
    }
    return carga.c;
  } catch {
    return null;
  }
}
