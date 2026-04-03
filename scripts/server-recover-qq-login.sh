#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${QQBOT_SERVER_ENV_FILE:-${ROOT_DIR}/.env.server}"
STATE_FILE="${QQBOT_SERVER_LOGIN_RECOVERY_FILE:-${ROOT_DIR}/.server-login-recovery.env}"

if [ $# -ne 1 ]; then
  echo "Usage: $0 prepare|restore" >&2
  exit 1
fi

ACTION="$1"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing server env file: ${ENV_FILE}" >&2
  exit 1
fi

load_env() {
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
}

restart_server_target() {
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  systemctl --user daemon-reload
  systemctl --user restart qqbot.target
}

prepare_manual_login() {
  load_env

  cat > "${STATE_FILE}" <<EOF
AUTO_LOGIN_QQ_ORIG=${AUTO_LOGIN_QQ:-}
EOF

  export AUTO_LOGIN_QQ=
  export QQBOT_PODMAN_NETWORK_NAME="${QQBOT_PODMAN_NETWORK_NAME:-qqbot-stack_app_network}"

  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop qqbot.target >/dev/null 2>&1 || true
  fi

  cd "${ROOT_DIR}"
  ./scripts/podman-stack-up.sh pmhq llbot
  ./scripts/verify-pmhq-network.sh

  cat <<EOF
Manual login recovery mode is ready.
- AUTO_LOGIN_QQ is temporarily cleared for this stack run only.
- Open the server LLBot WebUI and complete QR/manual login.
- After login succeeds, run: ${ROOT_DIR}/scripts/server-recover-qq-login.sh restore
EOF
}

restore_auto_login() {
  if [ ! -f "${STATE_FILE}" ]; then
    echo "Missing recovery state file: ${STATE_FILE}" >&2
    exit 1
  fi

  # shellcheck disable=SC1090
  . "${STATE_FILE}"
  rm -f "${STATE_FILE}"

  load_env
  export AUTO_LOGIN_QQ="${AUTO_LOGIN_QQ_ORIG:-${AUTO_LOGIN_QQ:-}}"

  restart_server_target
  echo "qqbot.target restarted with AUTO_LOGIN_QQ restored."
}

case "${ACTION}" in
  prepare)
    prepare_manual_login
    ;;
  restore)
    restore_auto_login
    ;;
  *)
    echo "Unknown action: ${ACTION}" >&2
    exit 1
    ;;
esac
