#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${QQBOT_COMPOSE_FILE:-${ROOT_DIR}/compose.yaml}"
NETWORK_NAME="${QQBOT_PODMAN_NETWORK_NAME:-qqbot-stack_app_network}"
PRIMARY_NETWORK_NAME="${QQBOT_PODMAN_PRIMARY_NETWORK_NAME:-podman}"
PMHQ_CONTAINER="${QQBOT_PMHQ_CONTAINER_NAME:-pmhq}"
LLBOT_CONTAINER="${QQBOT_LLBOT_CONTAINER_NAME:-llonebot}"

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

ensure_network_connected() {
  local container_name="$1"
  local alias="${2:-}"

  if podman inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "${container_name}" 2>/dev/null | grep -Fx "${NETWORK_NAME}" >/dev/null; then
    return 0
  fi

  if [ -n "${alias}" ]; then
    podman network connect --alias "${alias}" "${NETWORK_NAME}" "${container_name}" >/dev/null
  else
    podman network connect "${NETWORK_NAME}" "${container_name}" >/dev/null
  fi
}

ensure_network_connected "${PMHQ_CONTAINER}" "pmhq"
ensure_network_connected "${LLBOT_CONTAINER}"

# podman-compose sometimes attaches containers to the default `podman` network even when
# compose.yaml declares a named network. Disconnect to force service-name DNS through the
# pinned stack network.
podman network disconnect "${PRIMARY_NETWORK_NAME}" "${PMHQ_CONTAINER}" >/dev/null 2>&1 || true
podman network disconnect "${PRIMARY_NETWORK_NAME}" "${LLBOT_CONTAINER}" >/dev/null 2>&1 || true
