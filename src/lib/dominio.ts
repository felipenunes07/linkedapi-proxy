// ---------------------------------------------------------------------------
// Dominio proprio da tela de conexao (F2.30). Mora sozinho aqui, e nao dentro
// do portal, porque os DOIS caminhos que geram link de conexao precisam dele:
// o do cliente (src/routes/portal.ts) e o do operador (scripts/connect.ts).
// Enquanto so o portal reescrevia, o link gerado na mao mostrava a marca da
// origem para quem o operador estava tentando ajudar.
// ---------------------------------------------------------------------------

// A origem hospeda o wizard num
// dominio dela; com um CNAME nosso apontando para la (e o certificado que eles
// emitem), a MESMA tela responde no nosso dominio. Aqui so trocamos o host do
// link, preservando caminho, query e fragmento (e no caminho que esta o token
// do wizard).
//
// Falha ABERTA de proposito: host mal configurado mantem o link original, que
// funciona. Derrubar a conexao de quem ja pagou para nao mostrar uma marca
// seria o erro maior; o sinal interno avisa o operador.
export function aplicarDominioProprio(url: string, host: string | undefined): string {
  const alvo = (host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!alvo) {
    return url;
  }
  try {
    const original = new URL(url);
    const trocada = new URL(`https://${alvo}`);
    // So host: um valor com caminho, usuario ou porta estranha nao entra.
    if (trocada.host !== alvo || trocada.pathname !== '/') {
      console.error('connect_auth_host_invalido');
      return url;
    }
    original.protocol = 'https:';
    original.host = alvo;
    return original.toString();
  } catch {
    console.error('connect_auth_host_invalido');
    return url;
  }
}
