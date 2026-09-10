#!/usr/bin/env bash
# Smoke do go-live (docs/go-live.md secao H). Rode DEPOIS do `npm run deploy`:
#
#   npm run smoke
#
# So leitura: nada e criado. O checkout recebe um CPF invalido de proposito e
# e recusado ANTES de tocar o Asaas ou o banco.
set -uo pipefail

BASE="${1:-https://linkedapi-proxy.victor-58a.workers.dev}"
ORIGEM="https://linkedapi-site.pages.dev"
falhas=0

confere() {
  local nome="$1" esperado="$2" obtido="$3"
  if [ "$obtido" = "$esperado" ]; then
    echo "  ok    $nome ($obtido)"
  else
    echo "  FALHA $nome: esperado $esperado, veio $obtido"
    falhas=$((falhas + 1))
  fi
}

echo "Smoke em $BASE"

confere "GET /health" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")"

# Rota do painel existe (F2.20): sem token = 401. Worker antigo responde 404.
confere "GET /portal/status sem token" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/portal/status")"

# CORS do painel: preflight da landing com o header do token e o PUT.
confere "OPTIONS /portal/email (preflight da landing)" 204 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE/portal/email" \
      -H "Origin: $ORIGEM" -H 'Access-Control-Request-Method: PUT' \
      -H 'Access-Control-Request-Headers: x-portal-token, content-type')"

# Origem estranha continua barrada.
confere "POST /checkout de origem desconhecida" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/checkout" \
      -H 'Origin: https://site-desconhecido.example' -H 'content-type: application/json' -d '{}')"

# Checkout no ar e validando antes de cobrar: CPF invalido = 400, nada criado.
confere "POST /checkout com CPF invalido" 400 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/checkout" \
      -H "Origin: $ORIGEM" -H 'content-type: application/json' \
      -d '{"name":"Smoke Test","email":"smoke@example.com","cpf_cnpj":"111.111.111-11"}')"

# Chave inexistente continua 401 (F2.22 nao muda nada para quem nao tem chave).
confere "GET /v1/chats com chave inexistente" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/chats" -H 'X-API-KEY: lk_live_smoke_inexistente')"

confere "GET /docs" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/docs")"

if [ "$falhas" -gt 0 ]; then
  echo "$falhas verificacao(oes) falharam."
  exit 1
fi
echo "Tudo certo."
