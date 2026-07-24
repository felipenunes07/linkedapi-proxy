# Notas da Unipile

Nao colar doc inteira aqui. Este arquivo so aponta para as fontes e guarda os
poucos fatos estaveis. Para pesquisa profunda, use o subagent
`unipile-researcher`.

## Comece por aqui (indice legivel por maquina)
https://developer.unipile.com/llms.txt
Lista todas as paginas em Markdown e os endpoints em OpenAPI.

## Paginas mais relevantes para a V1
- API Usage (auth, DSN, Access Token): https://developer.unipile.com/docs/api-usage
- Guia LinkedIn: https://developer.unipile.com/docs/linkedin
- Enviar mensagens: https://developer.unipile.com/docs/send-messages
- Convidar usuarios (convites): https://developer.unipile.com/docs/invite-users
- Objeto de mensagem: https://developer.unipile.com/docs/message-payload
- Limites por provedor (rate limiter): https://developer.unipile.com/docs/provider-limits-and-restrictions
- Hosted Auth (Marco 4): https://developer.unipile.com/docs/hosted-auth
- Node.js SDK: https://github.com/unipile/unipile-node-sdk

## Fatos estaveis
- Base das chamadas: `https://{DSN}/api/v1/...`.
- Autenticacao por header com o access token (master token), injetado pelo
  servidor. Nunca do cliente, nunca em log.
- Escopo da V1: so LinkedIn; so enviar mensagem, enviar convite e listar chats.
- Desabilitar Recruiter/Jobs no parametro de conexao (Marco 4).

Method/path/payload exatos: confirmar na doc no momento de implementar, podem
mudar por versao.
