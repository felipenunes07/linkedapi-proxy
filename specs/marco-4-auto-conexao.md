# Spec, Marco 4: Auto-conexao (pode ser V1.5)

> Stub. Detalhar quando chegar a vez. Contexto: @PRD.md secao 9.

## Objetivo
Hosted auth da Unipile white-label: o proprio usuario conecta seu LinkedIn sem
tocar no painel da Unipile.

## Escopo previsto
- Backend gera link white-label de hosted auth.
- Redireciona o usuario e recebe o `account_id` em callback.
- Grava em `connected_accounts` vinculado ao tenant.
- Desabilitar Recruiter/Jobs no parametro de conexao (reduz suporte).

## Verificacao (criterio de aceite)
- Alguem que nao e a equipe conecta o proprio LinkedIn e sai com um
  `account_id` funcionando, sem tocar no painel da Unipile.

## Referencia
https://developer.unipile.com/docs/hosted-auth
