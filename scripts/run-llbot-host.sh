#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

export LLBOT_VERSION="${LLBOT_VERSION:-7.12.15}"
export LLBOT_RUNTIME_DIR="${LLBOT_RUNTIME_DIR:-${ROOT_DIR}/.runtime/llbot}"
export LLONEBOT_DATA_DIR="${LLONEBOT_DATA_DIR:-${ROOT_DIR}/.runtime/llonebot}"
export LLONEBOT_WEBUI_PORT="${LLONEBOT_WEBUI_PORT:-3080}"
export LLONEBOT_WS_PORT="${LLONEBOT_WS_PORT:-3001}"
export LLBOT_OB11_READY_TIMEOUT_SEC="${LLBOT_OB11_READY_TIMEOUT_SEC:-120}"
export LLONEBOT_DISABLE_WEBUI_AUTH="${LLONEBOT_DISABLE_WEBUI_AUTH:-true}"
export PMHQ_PORT="${PMHQ_PORT:-13000}"

HOST_HOME="${QQBOT_HOST_HOME:-${HOME:-}}"
if [ -z "${HOST_HOME}" ]; then
  HOST_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
fi
export QQBOT_HOST_HOME="${HOST_HOME}"
export HOME="${LLBOT_RUNTIME_DIR}/.host-home"

node "${ROOT_DIR}/scripts/lib/llbot-runtime.cjs" prepare

cd "${LLBOT_RUNTIME_DIR}"
node --enable-source-maps ./llbot.js \
  --pmhq-host=127.0.0.1 \
  "--pmhq-port=${PMHQ_PORT}" &
llbot_pid=$!

cleanup() {
  if kill -0 "${llbot_pid}" 2>/dev/null; then
    kill "${llbot_pid}" 2>/dev/null || true
    wait "${llbot_pid}" 2>/dev/null || true
  fi
}

trap cleanup INT TERM

deadline=$((SECONDS + LLBOT_OB11_READY_TIMEOUT_SEC))
while kill -0 "${llbot_pid}" 2>/dev/null; do
  if ss -H -ltnp "sport = :${LLONEBOT_WS_PORT}" 2>/dev/null | grep -F "pid=${llbot_pid}," >/dev/null; then
    wait "${llbot_pid}"
    exit $?
  fi
  if [ "${SECONDS}" -ge "${deadline}" ]; then
    echo "LLBot OB11 websocket port ${LLONEBOT_WS_PORT} did not become ready within ${LLBOT_OB11_READY_TIMEOUT_SEC}s" >&2
    cleanup
    exit 1
  fi
  sleep 1
done

wait "${llbot_pid}"
