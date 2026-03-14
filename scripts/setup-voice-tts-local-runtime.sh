#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DEST="$ROOT_DIR/.runtime/gpt-sovits-upstream"
ASSET_DEST="$ROOT_DIR/data/voice/tts-local"
UPSTREAM_REPO="${VOICE_TTS_UPSTREAM_REPO:-https://github.com/RVC-Boss/GPT-SoVITS}"
UPSTREAM_REF="${VOICE_TTS_UPSTREAM_REF:-main}"
SOURCE_PRETRAINED_ROOT="${VOICE_TTS_SOURCE_PRETRAINED_ROOT:-}"
SOURCE_MODEL_ROOT="${VOICE_TTS_SOURCE_MODEL_ROOT:-}"
SOURCE_REFERENCE_ROOT="${VOICE_TTS_SOURCE_REFERENCE_ROOT:-}"

usage() {
  cat <<'EOF'
Usage:
  setup-voice-tts-local-runtime.sh \
    --source-pretrained-root /path/to/pretrained_models \
    --source-model-root /path/to/GPT-SoVITS_models \
    --source-reference-root /path/to/reference_audio/sakiko

Optional env:
  VOICE_TTS_UPSTREAM_REPO
  VOICE_TTS_UPSTREAM_REF
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-pretrained-root)
      SOURCE_PRETRAINED_ROOT="$2"
      shift 2
      ;;
    --source-model-root)
      SOURCE_MODEL_ROOT="$2"
      shift 2
      ;;
    --source-reference-root)
      SOURCE_REFERENCE_ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$SOURCE_PRETRAINED_ROOT" || -z "$SOURCE_MODEL_ROOT" || -z "$SOURCE_REFERENCE_ROOT" ]]; then
  echo "Missing required source paths." >&2
  usage >&2
  exit 2
fi

for path in "$SOURCE_PRETRAINED_ROOT" "$SOURCE_MODEL_ROOT" "$SOURCE_REFERENCE_ROOT"; do
  if [[ ! -e "$path" ]]; then
    echo "Missing source path: $path" >&2
    exit 1
  fi
done

mkdir -p "$ROOT_DIR/.runtime" "$ASSET_DEST/models" "$ASSET_DEST/references"

if [[ ! -d "$UPSTREAM_DEST/.git" ]]; then
  git clone --depth=1 --branch "$UPSTREAM_REF" "$UPSTREAM_REPO" "$UPSTREAM_DEST"
else
  git -C "$UPSTREAM_DEST" fetch --depth=1 origin "$UPSTREAM_REF"
  git -C "$UPSTREAM_DEST" reset --hard FETCH_HEAD
fi

rsync -a --delete "$SOURCE_PRETRAINED_ROOT"/ "$ASSET_DEST/pretrained_models/"
rsync -a --delete "$SOURCE_MODEL_ROOT"/ "$ASSET_DEST/models/"
rsync -a --delete \
  --include 'black_sakiko.wav' \
  --include 'white_sakiko.wav' \
  --include 'reference_text_black_sakiko.txt' \
  --include 'reference_text_white_sakiko.txt' \
  --include 'reference_audio_language.txt' \
  --include 'QT_style.json' \
  --exclude '*' \
  "$SOURCE_REFERENCE_ROOT"/ "$ASSET_DEST/references/"

echo "Upstream runtime: $UPSTREAM_DEST"
echo "Copied assets: $ASSET_DEST"
