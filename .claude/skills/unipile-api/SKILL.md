---
name: unipile-api
description: Convencoes de como o proxy fala com a Unipile (base URL, injecao de segredos server-side, forma dos 3 endpoints da V1) e onde achar a doc oficial. Use ao implementar ou depurar qualquer chamada a Unipile.
---

# Como o proxy fala com a Unipile

## Fonte da verdade
Documentacao oficial, comece pelo indice: https://developer.unipile.com/llms.txt
Para pesquisa mais profunda, delegue ao subagent `unipile-researcher` para nao
poluir o contexto principal.

## Base URL e autenticacao
- Todas as chamadas vao para `https://{UNIPILE_DSN}/api/v1/...`.
- O `UNIPILE_MASTER_TOKEN` vai no header de autenticacao (`X-API-KEY` no padrao
  da Unipile), injetado pelo servidor. IMPORTANT: DSN e master token vem dos
  Worker secrets, nunca do request do cliente, nunca em log.
- O `account_id` da conta-mestra e resolvido no servidor (key -> tenant ->
  connected_accounts) e injetado. Nunca aceite `account_id` do cliente.

## Endpoints da V1 (apenas estes 3)
1. Enviar mensagem em chat existente.
2. Enviar convite de conexao.
3. Listar chats (para obter `chat_id`).

Confirme method, path e payload exatos na doc antes de implementar (eles mudam
por versao). Nao espelhe os 500+ endpoints da Unipile: so estes tres na V1.

## Limites (obrigatorio na V1)
Enviar mensagem e enviar convite sao as acoes que restringem contas no LinkedIn.
Antes de implementar limites default, leia:
https://developer.unipile.com/docs/provider-limits-and-restrictions
e parta dos valores conservadores recomendados.

## Repasse de erros
Nao repasse erros crus da Unipile ao cliente se puderem vazar DSN/infra.
Normalize para um formato de erro proprio.
