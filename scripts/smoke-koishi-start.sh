#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Provide deterministic minimal runtime env for local/CI smoke start.
export ONEBOT_SELF_ID="${ONEBOT_SELF_ID:-100000001}"
export ONEBOT_TOKEN="${ONEBOT_TOKEN:-}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.deepseek.com/v1}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-sk-ci-smoke}"
export OPENAI_MODEL="${OPENAI_MODEL:-deepseek/deepseek-chat}"
export TASK_AUTOMATION_INTENT_ENABLED="${TASK_AUTOMATION_INTENT_ENABLED:-false}"
export POKEMON_BATTLE_ENABLED="${POKEMON_BATTLE_ENABLED:-false}"
export WEB_SEARCH_LLM_PLANNER_ENABLED="${WEB_SEARCH_LLM_PLANNER_ENABLED:-false}"
export WEB_SEARCH_LLM_RERANK_ENABLED="${WEB_SEARCH_LLM_RERANK_ENABLED:-false}"
export QQ_VOICE_ENABLED="${QQ_VOICE_ENABLED:-false}"

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
  'database-sqlite:8jr5yp',
  'cron:task',
  './dist/plugins/task-automation:automation',
  './dist/plugins/qq-voice:voice',
  'chatluna:0qm1bk',
  './dist/plugins/web-search:search',
  './dist/plugins/chatluna-sticker:sticker',
  './dist/plugins/chatluna-model-guard:mjddgg',
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

if ! grep -F "loader apply plugin ./dist/plugins/task-automation" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load task-automation plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/qq-voice:voice" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load qq-voice plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/web-search:search" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load web-search plugin." >&2
  exit 1
fi

if ! grep -F "loader apply plugin ./dist/plugins/chatluna-model-guard" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup did not load chatluna-model-guard plugin." >&2
  exit 1
fi

if grep -nE "loader apply plugin adapter-onebot:onebot|loader apply plugin server:|loader apply plugin console:|loader apply plugin chatluna-deepseek-adapter:|loader apply plugin chatluna-ollama-adapter:" "$LOG_FILE" >/dev/null; then
  echo "Koishi smoke startup unexpectedly loaded external dependency plugins." >&2
  exit 1
fi

echo "Koishi smoke startup check passed."
