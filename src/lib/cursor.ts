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
