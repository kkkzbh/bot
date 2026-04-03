#!/usr/bin/env bash
set -euo pipefail

NETWORK_NAME="${QQBOT_PODMAN_NETWORK_NAME:-qqbot-stack_app_network}"
PMHQ_CONTAINER="${QQBOT_PMHQ_CONTAINER_NAME:-pmhq}"
LLBOT_CONTAINER="${QQBOT_LLBOT_CONTAINER_NAME:-llonebot}"
PMHQ_HOST="${QQBOT_PMHQ_HOST:-pmhq}"
PMHQ_PORT="${QQBOT_PMHQ_PORT:-${PMHQ_PORT:-13000}}"
LLBOT_WEBUI_PORT="${QQBOT_LLBOT_WEBUI_PORT:-${LLONEBOT_WEBUI_PORT:-3080}}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[verify] missing command: $1" >&2
    exit 2
  fi
}

require_cmd podman
require_cmd node

node_probe() {
  local host="$1"
  local port="$2"
  local label="$3"

  node -e "
    const net = require('node:net');
    const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) });
    socket.setTimeout(5000);
    socket.on('connect', () => {
      console.log(process.argv[3] + ' OK');
      socket.end();
    });
    socket.on('timeout', () => {
      console.error(process.argv[3] + ' TIMEOUT');
      process.exit(1);
    });
    socket.on('error', (error) => {
      console.error(process.argv[3] + ' ERROR ' + error.message);
      process.exit(1);
    });
  " "${host}" "${port}" "${label}"
}

container_networks() {
  local container_name="$1"

  podman inspect \
    --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \
    "${container_name}" 2>/dev/null || return 1
}

container_has_network() {
  local container_name="$1"

  container_networks "${container_name}" | grep -Fx "${NETWORK_NAME}" >/dev/null || return 1
}

container_is_running() {
  local container_name="$1"

  local running
  running="$(podman inspect --format '{{.State.Running}}' "${container_name}" 2>/dev/null || echo 'false')"
  [ "${running}" = "true" ]
}

wait_until() {
  local description="$1"
  shift

  local attempt
  for attempt in $(seq 1 60); do
    if "$@"; then
      echo "${description}: OK"
      return 0
    fi
    sleep 1
  done

  echo "${description}: FAILED" >&2
  return 1
}

llbot_node() {
  local source="$1"
  shift
  podman exec "${LLBOT_CONTAINER}" node -e "${source}" "$@"
}

llbot_logs_contain() {
  local pattern="$1"

  podman logs "${LLBOT_CONTAINER}" 2>&1 | grep -F "${pattern}" >/dev/null
}

diag_probe() {
  local host="$1"
  local port="$2"
  local label="$3"

  if node_probe "${host}" "${port}" "${label}" >/dev/null 2>&1; then
    echo "${label}: OK"
  else
    echo "${label}: FAILED"
  fi
}

print_diagnostics() {
  echo "== podman inspect network info =="
  for container_name in "${PMHQ_CONTAINER}" "${LLBOT_CONTAINER}"; do
    echo "-- ${container_name} --"
    podman inspect --format '{{json .NetworkSettings.Networks}}' "${container_name}" 2>/dev/null || true
  done

  echo "== llonebot logs =="
  podman logs "${LLBOT_CONTAINER}" 2>&1 || true

  echo "== pmhq logs =="
  podman logs "${PMHQ_CONTAINER}" 2>&1 || true

  echo "== llonebot /etc/hosts =="
  podman exec "${LLBOT_CONTAINER}" cat /etc/hosts 2>/dev/null || true

  echo "== port probes =="
  diag_probe "127.0.0.1" "${LLBOT_WEBUI_PORT}" "host 127.0.0.1:${LLBOT_WEBUI_PORT}"

  echo "== llonebot websocket status =="
  podman logs "${LLBOT_CONTAINER}" 2>&1 | grep -F "PMHQ WebSocket" || true
}

on_exit() {
  local exit_code="$1"
  if [ "${exit_code}" -ne 0 ]; then
    print_diagnostics >&2
  fi
}

trap 'on_exit $?' EXIT

wait_until "${PMHQ_CONTAINER} is running" container_is_running "${PMHQ_CONTAINER}"
wait_until "${LLBOT_CONTAINER} is running" container_is_running "${LLBOT_CONTAINER}"
wait_until "${PMHQ_CONTAINER} joined ${NETWORK_NAME}" container_has_network "${PMHQ_CONTAINER}"
wait_until "${LLBOT_CONTAINER} joined ${NETWORK_NAME}" container_has_network "${LLBOT_CONTAINER}"

wait_until "${LLBOT_CONTAINER} resolves ${PMHQ_HOST}" \
  llbot_node "require('node:dns').promises.lookup(process.argv[1]).then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exit(1) })" \
  "${PMHQ_HOST}"

wait_until "${LLBOT_CONTAINER} reaches ${PMHQ_HOST}:${PMHQ_PORT}" \
  llbot_node "
    const net = require('node:net');
    const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) });
    socket.setTimeout(5000);
    socket.on('connect', () => socket.end());
    socket.on('close', () => process.exit(0));
    socket.on('timeout', () => process.exit(1));
    socket.on('error', () => process.exit(1));
  " "${PMHQ_HOST}" "${PMHQ_PORT}"

wait_until "host reaches 127.0.0.1:${LLBOT_WEBUI_PORT}" \
  node_probe "127.0.0.1" "${LLBOT_WEBUI_PORT}" "host 127.0.0.1:${LLBOT_WEBUI_PORT}"

wait_until "${LLBOT_CONTAINER} completes PMHQ WebSocket handshake" \
  llbot_logs_contain "PMHQ WebSocket 连接成功"
