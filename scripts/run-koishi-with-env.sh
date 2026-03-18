#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_env_file() {
  if [[ -n "${QQBOT_ENV_FILE:-}" ]]; then
    local explicit="${QQBOT_ENV_FILE}"
    if [[ "$explicit" != /* ]]; then
      explicit="${ROOT_DIR}/${explicit}"
    fi
    printf '%s\n' "$explicit"
    return
  fi

  printf '%s\n' "${ROOT_DIR}/.env.local"
}

ENV_FILE="$(resolve_env_file)"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[error] bot env file not found: $ENV_FILE" >&2
  exit 2
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
echo "[info] Loaded bot env: $ENV_FILE"

cd "$ROOT_DIR"
pnpm build
exec pnpm exec koishi start koishi.yml
