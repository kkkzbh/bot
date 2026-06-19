#!/usr/bin/env bash
set -euo pipefail

SYSTEMD_TARGET="${DEPLOY_SYSTEMD_TARGET:-${QQBOT_SYSTEMD_TARGET:-qqbot.target}}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[prereq] missing command: $1" >&2
    exit 2
  fi
}

require_cmd bash
require_cmd tar
require_cmd node
if ! command -v corepack >/dev/null 2>&1 && ! command -v npm >/dev/null 2>&1; then
  echo "[prereq] missing command: corepack or npm" >&2
  exit 2
fi
require_cmd pnpm
require_cmd systemctl
require_cmd journalctl
require_cmd google-chrome
require_cmd podman

if ! command -v podman-compose >/dev/null 2>&1 && ! podman compose version >/dev/null 2>&1; then
  echo "[prereq] missing podman compose support" >&2
  exit 2
fi

if [[ "${SYSTEMD_TARGET}" == "qqbot.target" ]]; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  if [[ ! -S "${XDG_RUNTIME_DIR}/bus" ]]; then
    echo "[prereq] user systemd bus is not available at ${XDG_RUNTIME_DIR}/bus" >&2
    exit 2
  fi
fi

echo "[prereq] host prerequisites are available"
