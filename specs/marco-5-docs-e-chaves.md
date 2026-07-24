# Spec, Marco 5: Documentacao minima e emissao de chave

> Stub. Detalhar quando chegar a vez. Contexto: @PRD.md secao 9.

## Objetivo
Entregar a uma pessoa de teste uma chave + link de doc, e ela usa sem explicacao
verbal (o criterio de sucesso da V1).

## Escopo previsto
- OpenAPI spec dos 3 endpoints da V1.
- Renderizar com Scalar (https://github.com/scalar/scalar).
- Forma simples de emitir/revogar chave (pode ser script no inicio): gera chave,
  guarda so o hash em `api_keys`, exibe o valor em claro uma unica vez.

## Verificacao (criterio de aceite)
- Uma pessoa nao-desenvolvedora recebe chave + link e consegue enviar mensagem e
  convite sozinha, sem nunca ver a palavra "Unipile".
