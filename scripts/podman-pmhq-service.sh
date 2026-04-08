#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${QQBOT_COMPOSE_FILE:-${ROOT_DIR}/compose.yaml}"
PMHQ_CONTAINER="${QQBOT_PMHQ_CONTAINER_NAME:-pmhq}"
LEGACY_LLBOT_CONTAINER="${QQBOT_LLBOT_CONTAINER_NAME:-llonebot}"
ENV_FILE="${QQBOT_ENV_FILE:-}"

if [ -n "${ENV_FILE}" ]; then
  if [ "${ENV_FILE#/}" = "${ENV_FILE}" ]; then
    ENV_FILE="${ROOT_DIR}/${ENV_FILE}"
  fi
  if [ -f "${ENV_FILE}" ]; then
    set -a
    # shellcheck disable=SC1090
    . "${ENV_FILE}"
    set +a
  fi
fi

if [ -n "${QQBOT_PODMAN_COMPOSE_BIN:-}" ]; then
  COMPOSE_CMD=("${QQBOT_PODMAN_COMPOSE_BIN}")
elif command -v podman-compose >/dev/null 2>&1; then
  COMPOSE_CMD=("$(command -v podman-compose)")
elif command -v podman >/dev/null 2>&1; then
  COMPOSE_CMD=("$(command -v podman)" "compose")
else
  echo "podman compose command is not available" >&2
  exit 1
fi

compose() {
  "${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" "$@"
}

remove_legacy_llbot_container() {
  podman rm -f "${LEGACY_LLBOT_CONTAINER}" >/dev/null 2>&1 || true
}

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 up|stop|restart" >&2
  exit 1
fi

case "$1" in
  up)
    remove_legacy_llbot_container
    compose up -d pmhq
    ;;
  stop)
    compose stop pmhq
    ;;
  restart)
    remove_legacy_llbot_container
    compose stop pmhq || true
    compose up -d pmhq
    ;;
  *)
    echo "Unknown action: $1" >&2
    exit 1
    ;;
esac

if [ "$1" != "stop" ]; then
  podman inspect --format '{{.State.Running}}' "${PMHQ_CONTAINER}" 2>/dev/null | grep -Fx true >/dev/null
fi
