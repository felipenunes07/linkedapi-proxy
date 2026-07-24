#!/usr/bin/env bash
# PreToolUse hook: bloqueia escrita/edicao em arquivos de segredo.
# Torna deterministica a regra "master token e DSN nunca em arquivo versionado".
# Recebe o payload da tool via stdin (JSON). Sai com codigo 2 para BLOQUEAR.

set -euo pipefail

payload="$(cat)"

# Extrai o caminho do arquivo alvo (Write/Edit usam file_path).
file_path="$(printf '%s' "$payload" | grep -oE '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')"

if [ -z "${file_path:-}" ]; then
  exit 0
fi

base="$(basename "$file_path")"

# Padroes de segredo que NUNCA devem ser escritos por aqui.
# `.dev.vars.example` e permitido de proposito (template sem valores reais).
case "$base" in
  .dev.vars|.env|.env.*)
    echo "BLOQUEADO: '$base' guarda segredos e nao deve ser criado/editado pelo agente. Edite manualmente e mantenha fora do git." >&2
    exit 2
    ;;
esac

case "$file_path" in
  *.env.example|*.dev.vars.example)
    exit 0
    ;;
  */secrets/*|secrets/*|*.pem|*.key)
    echo "BLOQUEADO: caminho de segredo ('$file_path'). Segredos vivem em Worker secrets / .dev.vars, fora do git." >&2
    exit 2
    ;;
esac

exit 0
