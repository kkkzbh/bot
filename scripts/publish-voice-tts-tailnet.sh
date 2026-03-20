#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${QQBOT_VOICE_TTS_TAILNET_ENV_FILE:-$ROOT_DIR/config/voice-tts.tailnet.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[error] Missing command: $1" >&2
    exit 2
  fi
}

usage() {
  cat <<'EOF'
Usage:
  publish-voice-tts-tailnet.sh apply
  publish-voice-tts-tailnet.sh clear
  publish-voice-tts-tailnet.sh status

Environment:
  QQBOT_VOICE_TTS_TAILNET_ENV_FILE   Tailnet publish env file path

Env file keys:
  VOICE_TTS_TAILNET_PORT             Tailnet-exposed TCP port (default: 5162)
  VOICE_TTS_LOCAL_UPSTREAM_HOST      Local upstream host (default: 127.0.0.1)
  VOICE_TTS_LOCAL_UPSTREAM_PORT      Local upstream port (default: 5162)
EOF
}

port="${VOICE_TTS_TAILNET_PORT:-5162}"
upstream_host="${VOICE_TTS_LOCAL_UPSTREAM_HOST:-127.0.0.1}"
upstream_port="${VOICE_TTS_LOCAL_UPSTREAM_PORT:-5162}"
service_name="tcp:${port}"
target="tcp://${upstream_host}:${upstream_port}"

case "${1:-}" in
  apply)
    require_cmd tailscale
    tailscale serve --bg --tcp "$port" "$target"
    ;;
  clear)
    require_cmd tailscale
    tailscale serve clear "$service_name"
    ;;
  status)
    require_cmd tailscale
    tailscale serve status
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "[error] Unknown command: ${1:-}" >&2
    usage >&2
    exit 2
    ;;
esac
