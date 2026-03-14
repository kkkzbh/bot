#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${QQBOT_VOICE_TTS_ENV_FILE:-$ROOT_DIR/config/voice-tts.local.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

PYTHON_BIN="${VOICE_TTS_PYTHON_BIN:-python3}"

exec "$PYTHON_BIN" -m uvicorn app:APP \
  --app-dir "$ROOT_DIR/docker/voice-tts" \
  --host "${VOICE_TTS_HOST:-0.0.0.0}" \
  --port "${VOICE_TTS_PORT:-5162}"
