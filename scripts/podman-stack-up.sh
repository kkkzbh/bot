#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${QQBOT_COMPOSE_FILE:-${ROOT_DIR}/compose.yaml}"
NETWORK_NAME="${QQBOT_PODMAN_NETWORK_NAME:-qqbot-stack_app_network}"

if [ "$#" -gt 0 ]; then
  SERVICES=("$@")
else
  SERVICES=(pmhq llbot)
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

if ! command -v podman >/dev/null 2>&1; then
  echo "podman is not installed" >&2
  exit 1
fi

compose() {
  "${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" "$@"
}

patch_cni_config() {
  local config_path

  for config_path in \
    "/etc/cni/net.d/${NETWORK_NAME}.conflist" \
    "${HOME}/.config/cni/net.d/${NETWORK_NAME}.conflist"
  do
    [ -f "${config_path}" ] || continue
    sed -i 's/"cniVersion": "1.0.0"/"cniVersion": "0.4.0"/' "${config_path}"
  done
}

cd "${ROOT_DIR}"

compose down --remove-orphans || true

if podman network exists "${NETWORK_NAME}" >/dev/null 2>&1; then
  podman network rm -f "${NETWORK_NAME}" >/dev/null
fi

podman network create "${NETWORK_NAME}" >/dev/null
patch_cni_config

compose up -d "${SERVICES[@]}"
