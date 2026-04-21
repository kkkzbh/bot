#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

./scripts/ensure-chatluna-build.sh

# Provide deterministic minimal runtime env for local/CI smoke start.
export ONEBOT_SELF_ID="${ONEBOT_SELF_ID:-100000001}"
export ONEBOT_TOKEN="${ONEBOT_TOKEN:-}"
if [[ -z "${KOISHI_PORT:-}" ]]; then
  export KOISHI_PORT="$(
    python - <<'PY'
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
  )"
else
  export KOISHI_PORT
fi
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.deepseek.com/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-ci-smoke}"
export CHATLUNA_ACTIVE_TAB="${CHATLUNA_ACTIVE_TAB:-siliconflow}"
export CHATLUNA_PLATFORM="${CHATLUNA_PLATFORM:-siliconflow}"
export CHATLUNA_BASE_URL="${CHATLUNA_BASE_URL:-https://api.siliconflow.cn/v1}"
export CHATLUNA_API_KEY="${CHATLUNA_API_KEY:-sk-ci-smoke}"
export CHATLUNA_DEFAULT_MODEL="${CHATLUNA_DEFAULT_MODEL:-Pro/moonshotai/Kimi-K2.5}"
export OPENAI_MODEL="${OPENAI_MODEL:-deepseek/deepseek-chat}"
export TASK_AUTOMATION_INTENT_ENABLED="${TASK_AUTOMATION_INTENT_ENABLED:-false}"
export CHATLUNA_SEARCH_SERVICE_ENABLED="${CHATLUNA_SEARCH_SERVICE_ENABLED:-true}"
export CHATLUNA_SEARCH_SERVICE_TOPK="${CHATLUNA_SEARCH_SERVICE_TOPK:-5}"
export CHATLUNA_SEARCH_SERVICE_SUMMARY_TYPE="${CHATLUNA_SEARCH_SERVICE_SUMMARY_TYPE:-speed}"
export CHATLUNA_SEARCH_SERVICE_SUMMARY_MODEL="${CHATLUNA_SEARCH_SERVICE_SUMMARY_MODEL:-empty}"
export CHATLUNA_SEARCH_SERVICE_TAVILY_API_KEY="${CHATLUNA_SEARCH_SERVICE_TAVILY_API_KEY:-tvly-ci-smoke}"
export QQ_VOICE_INPUT_ENABLED="${QQ_VOICE_INPUT_ENABLED:-false}"
export QQ_VOICE_OUTPUT_ENABLED="${QQ_VOICE_OUTPUT_ENABLED:-false}"

LOG_FILE="$(mktemp)"
TMP_KOISHI_YML="$(mktemp "$ROOT_DIR/koishi-smoke-XXXXXX.yml")"
cleanup() {
  rm -f "$LOG_FILE"
  rm -f "$TMP_KOISHI_YML"
}
trap cleanup EXIT

cp koishi.yml "$TMP_KOISHI_YML"

node --input-type=module - "$TMP_KOISHI_YML" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';

const filePath = process.argv[2];
const config = YAML.parse(readFileSync(filePath, 'utf8'));
const entry = config?.plugins?.['group:entry'];

if (!entry || typeof entry !== 'object') {
  throw new Error('Invalid koishi.yml: missing plugins.group:entry');
}

const keep = new Set([
  'server:0b8t2q',
  'console:9xw6ka',
  './dist/plugins/bot-console:bot-console',
  'database-sqlite:8jr5yp',
  'cron:task',
  './dist/plugins/automation:automation',
  './dist/plugins/reply:voice',
  'chatluna:0qm1bk',
  'puppeteer:0vx5c7',
  'chatluna-search-service:search',
  './dist/plugins/sticker:sticker',
  './dist/plugins/model-guard:mjddgg',
  './dist/plugins/memory:memory-v2',
]);

for (const key of Object.keys(entry)) {
  if (!keep.has(key)) {
    delete entry[key];
  }
}

writeFileSync(filePath, YAML.stringify(config), 'utf8');
NODE

set +e
timeout 25s pnpm exec koishi start "$TMP_KOISHI_YML" >"$LOG_FILE" 2>&1
exit_code=$?
set -e

cat "$LOG_FILE"

# 25s timeout is expected for smoke startup.
if [[ "$exit_code" -ne 0 && "$exit_code" -ne 124 ]]; then
  echo "Koishi smoke startup exited unexpectedly with code: $exit_code" >&2
  exit "$exit_code"
fi

if grep -nE "cannot resolve plugin|property database is not registered|TypeError: Cannot read properties of undefined|\\[E\\] app .*TypeError|\\[E\\] app .*ReferenceError|\\[E\\] app .*SyntaxError" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup detected runtime errors in logs." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/automation" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load task-automation plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/reply:voice" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load qq-voice plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin chatluna-search-service:search" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load chatluna-search-service plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/model-guard" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load chatluna-model-guard plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/memory:memory-v2" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load memory-v2 plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/bot-console:bot-console" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load bot-console plugin." >&2
  exit 1
fi

if grep -F "loader apply plugin ./dist/plugins/web-search:search" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup unexpectedly loaded deleted local web-search plugin." >&2
  exit 1
fi

if grep -nE "loader apply plugin adapter-onebot:onebot|loader apply plugin chatluna-openai-like-adapter:" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup unexpectedly loaded external dependency plugins." >&2
  exit 1
fi

echo "Koishi smoke startup check passed."
