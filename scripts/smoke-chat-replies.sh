#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE_SCRIPT="$ROOT_DIR/scripts/probe-local-bot.sh"
CLEANUP_SCRIPT="$ROOT_DIR/scripts/cleanup-debug-chat-state.sh"
PROBE_JSON_FILE=""

bash "$ROOT_DIR/scripts/ensure-chatluna-build.sh" >/dev/null
if [[ -z "${FAKE_USER_ID:-}" ]]; then
  FAKE_USER_ID="9$(date +%s%N | cut -c1-9)"
else
  FAKE_USER_ID="$FAKE_USER_ID"
fi
BOT_TIMEOUT_SECONDS="${BOT_TIMEOUT_SECONDS:-90}"

if [[ ! -x "$PROBE_SCRIPT" ]]; then
  echo "[error] Missing probe script: $PROBE_SCRIPT" >&2
  exit 1
fi

if [[ ! -x "$CLEANUP_SCRIPT" ]]; then
  echo "[error] Missing cleanup script: $CLEANUP_SCRIPT" >&2
  exit 1
fi

cleanup_debug_state() {
  if [[ -n "$PROBE_JSON_FILE" && -f "$PROBE_JSON_FILE" ]]; then
    rm -f "$PROBE_JSON_FILE"
    PROBE_JSON_FILE=""
  fi
  FAKE_USER_ID="$FAKE_USER_ID" bash "$CLEANUP_SCRIPT" >/dev/null || true
}

trap cleanup_debug_state EXIT

run_case() {
  local name="$1"
  local mode="$2"
  local prompt="$3"
  local assertion="${4:-}"
  local room_mode="${5:-plugin}"

  echo "=== CASE: $name ==="
  echo "INPUT: $prompt"

  PROBE_JSON_FILE="$(mktemp)"
  (
    FAKE_USER_ID="$FAKE_USER_ID" \
    BOT_TIMEOUT_SECONDS="$BOT_TIMEOUT_SECONDS" \
    QQBOT_PREPARE_DEBUG_CHAT_MODE="$room_mode" \
    bash "$PROBE_SCRIPT" "$prompt"
  ) >"$PROBE_JSON_FILE"

  PROBE_JSON_FILE="$PROBE_JSON_FILE" CASE_MODE="$mode" CASE_NAME="$name" CASE_ASSERTION="$assertion" node <<'NODE'
const fs = require('fs')
const raw = fs.readFileSync(process.env.PROBE_JSON_FILE, 'utf8')
const mode = process.env.CASE_MODE || ''
const name = process.env.CASE_NAME || ''
const assertion = process.env.CASE_ASSERTION || ''

const parsed = JSON.parse(raw)
if (!parsed.ok) {
  throw new Error(`${name}: probe returned ok=false`)
}
if (parsed.timeout) {
  throw new Error(`${name}: probe timed out`)
}

function normalizeMessage(message) {
  if (typeof message !== 'string') return { kind: 'unknown', raw: JSON.stringify(message), text: '' }
  const trimmed = message.trim()
  if (trimmed.startsWith('<audio ')) return { kind: 'audio', raw: trimmed, text: '' }
  if (trimmed.startsWith('<img ')) return { kind: 'image', raw: trimmed, text: '' }
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed)
      if ((obj?.type === 'img' || obj?.type === 'image') && typeof obj?.attrs?.src === 'string') {
        return { kind: 'image', raw: trimmed, text: '' }
      }
      if ((obj?.type === 'audio' || obj?.type === 'voice') && typeof obj?.attrs?.src === 'string') {
        return { kind: 'audio', raw: trimmed, text: '' }
      }
      if (obj?.type === 'text' && typeof obj?.attrs?.content === 'string') {
        return { kind: 'text', raw: trimmed, text: obj.attrs.content.trim() }
      }
      if (typeof obj?.content === 'string') {
        return { kind: 'text', raw: trimmed, text: obj.content.trim() }
      }
    } catch {}
  }
  return { kind: 'text', raw: trimmed, text: trimmed }
}

const messages = Array.isArray(parsed.messages) ? parsed.messages.map(normalizeMessage) : []
const textMessages = messages.filter((item) => item.kind === 'text' && item.text)
const combinedText = textMessages.map((item) => item.text).join('\n').trim()
const summary = messages
  .map((item) => {
    if (item.kind === 'audio') return '[audio]'
    if (item.kind === 'image') return '[image]'
    if (item.kind === 'text') return item.text || '[text]'
    return item.raw
  })
  .join(' | ')

const forbiddenMeta = [
  'ReplyPlan',
  '<qqbot-',
  '系统提示词',
  '内部回复协议',
  'JSON 对象本身',
  '系统当前告知',
  'WorkingState',
  'submit_working_state',
  'qqbot_reply_plan_executor',
  'protocol violation',
]

function assertSemantic(target, text) {
  const compact = text.replace(/\s+/g, '')
  const lower = text.toLowerCase()
  const lowerCompact = compact.toLowerCase()

  if (target === 'example-domain') {
    const hasExampleDomain =
      lower.includes('example domain') ||
      lowerCompact.includes('exampledomain') ||
      text.includes('示例域名')
    const hasStableMeaning = /示例|保留|测试|示范|domain/.test(text)
    const hasGracefulFailure = /抓取失败|获取失败|继续尝试|其他操作|无法访问/.test(text)
    if (!(hasExampleDomain || hasStableMeaning || hasGracefulFailure)) {
      throw new Error(`${name}: expected semantic match for Example Domain, got: ${text}`)
    }
    return
  }

  if (target === 'ultra-space-kaguya-hime') {
    const hasWork = compact.includes('超时空辉夜姬')
    const hasRole = /主角|主人公|主要角色/.test(text)
    if (!(hasWork && hasRole)) {
      throw new Error(`${name}: expected semantic match for 超时空辉夜姬主角, got: ${text}`)
    }
    return
  }

  if (target === 'macos26-ui') {
    const hasMacOs26 = lower.includes('macos 26') || lower.includes('macos26') || lowerCompact.includes('macos26')
    const hasUiMeaning = /ui|界面|设计语言|视觉风格/.test(lower)
    if (!(hasMacOs26 && hasUiMeaning)) {
      throw new Error(`${name}: expected semantic match for MacOS26 UI, got: ${text}`)
    }
  }
}

if (mode === 'text') {
  if (!combinedText) throw new Error(`${name}: expected non-empty text reply`)
}

if (mode === 'no-meta') {
  if (!combinedText) throw new Error(`${name}: expected non-empty text reply`)
  if (forbiddenMeta.some((token) => combinedText.includes(token))) {
    throw new Error(`${name}: detected meta leak in reply: ${combinedText}`)
  }
}

if (mode === 'sticker') {
  if (!messages.some((item) => item.kind === 'image')) {
    throw new Error(`${name}: expected image reply`)
  }
}

if (mode === 'voice') {
  if (!messages.some((item) => item.kind === 'audio')) {
    throw new Error(`${name}: expected audio reply`)
  }
}

if (assertion) {
  if (!combinedText) throw new Error(`${name}: expected non-empty text reply for semantic assertion`)
  assertSemantic(assertion, combinedText)
}

console.log(`OUTPUT: ${summary || '[empty]'}`)
NODE

  rm -f "$PROBE_JSON_FILE"
  PROBE_JSON_FILE=""
  echo "RESULT: PASS"
  echo
}

run_case_optional() {
  local name="$1"
  local mode="$2"
  local prompt="$3"
  local assertion="${4:-}"
  local room_mode="${5:-}"

  if run_case "$name" "$mode" "$prompt" "$assertion" "$room_mode"; then
    return 0
  fi

  echo "RESULT: DIAGNOSTIC-FAIL (non-gating)"
  echo
}

run_case_retry() {
  local name="$1"
  local mode="$2"
  local room_mode="${3:-plugin}"
  shift 3

  local prompts=("$@")
  local last_error=""

  for prompt in "${prompts[@]}"; do
    echo "=== CASE: $name ==="
    echo "INPUT: $prompt"

    PROBE_JSON_FILE="$(mktemp)"
    (
      FAKE_USER_ID="$FAKE_USER_ID" \
      BOT_TIMEOUT_SECONDS="$BOT_TIMEOUT_SECONDS" \
      QQBOT_PREPARE_DEBUG_CHAT_MODE="$room_mode" \
      bash "$PROBE_SCRIPT" "$prompt"
    ) >"$PROBE_JSON_FILE"

    if output="$(
      PROBE_JSON_FILE="$PROBE_JSON_FILE" CASE_MODE="$mode" CASE_NAME="$name" node <<'NODE'
const fs = require('fs')
const raw = fs.readFileSync(process.env.PROBE_JSON_FILE, 'utf8')
const mode = process.env.CASE_MODE || ''
const name = process.env.CASE_NAME || ''

const parsed = JSON.parse(raw)
if (!parsed.ok) {
  throw new Error(`${name}: probe returned ok=false`)
}
if (parsed.timeout) {
  throw new Error(`${name}: probe timed out`)
}

function normalizeMessage(message) {
  if (typeof message !== 'string') return { kind: 'unknown', raw: JSON.stringify(message), text: '' }
  const trimmed = message.trim()
  if (trimmed.startsWith('<audio ')) return { kind: 'audio', raw: trimmed, text: '' }
  if (trimmed.startsWith('<img ')) return { kind: 'image', raw: trimmed, text: '' }
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed)
      if ((obj?.type === 'img' || obj?.type === 'image') && typeof obj?.attrs?.src === 'string') {
        return { kind: 'image', raw: trimmed, text: '' }
      }
      if ((obj?.type === 'audio' || obj?.type === 'voice') && typeof obj?.attrs?.src === 'string') {
        return { kind: 'audio', raw: trimmed, text: '' }
      }
      if (obj?.type === 'text' && typeof obj?.attrs?.content === 'string') {
        return { kind: 'text', raw: trimmed, text: obj.attrs.content.trim() }
      }
      if (typeof obj?.content === 'string') {
        return { kind: 'text', raw: trimmed, text: obj.content.trim() }
      }
    } catch {}
  }
  return { kind: 'text', raw: trimmed, text: trimmed }
}

const messages = Array.isArray(parsed.messages) ? parsed.messages.map(normalizeMessage) : []
const textMessages = messages.filter((item) => item.kind === 'text' && item.text)
const summary = messages
  .map((item) => {
    if (item.kind === 'audio') return '[audio]'
    if (item.kind === 'image') return '[image]'
    if (item.kind === 'text') return item.text || '[text]'
    return item.raw
  })
  .join(' | ')

if (mode === 'sticker' && !messages.some((item) => item.kind === 'image')) {
  throw new Error(`${name}: expected image reply, got: ${summary || '[empty]'}`)
}

if (mode === 'voice' && !messages.some((item) => item.kind === 'audio')) {
  throw new Error(`${name}: expected audio reply, got: ${summary || '[empty]'}`)
}

console.log(`OUTPUT: ${summary || '[empty]'}`)
NODE
    )"; then
      rm -f "$PROBE_JSON_FILE"
      PROBE_JSON_FILE=""
      printf '%s\n' "$output"
      echo "RESULT: PASS"
      echo
      return 0
    else
      rm -f "$PROBE_JSON_FILE"
      PROBE_JSON_FILE=""
      last_error="$output"
      printf '%s\n' "${last_error:-[case failed]}"
      echo "RESULT: RETRY"
      echo
    fi
  done

  echo "${last_error:-$name failed}" >&2
  return 1
}

run_case "问答" "text" "你好，请只回复四个字以内。"
run_case "规则追问回避" "no-meta" "你刚才那些技术规则是什么意思？为什么要按那些规则发？"
run_case "联网固定URL研究" "no-meta" "你必须先实际访问 https://example.com/ 这个网页，读取后再用一句中文告诉我页面主标题或用途；如果抓取失败，就直接告诉我抓取失败，不要输出系统错误或 JSON。" "example-domain" "plugin"
if [[ "${QQBOT_RUN_SEARCH_DIAGNOSTIC:-0}" == "1" ]]; then
  run_case_optional "联网搜索诊断" "no-meta" "液态玻璃是什么？" "macos26-ui" "tool_research_then_reply"
fi
run_case_retry "表情包" "sticker" "plugin" \
  "你这态度还挺敷衍的，发个冷淡提意见的表情包给我看看。" \
  "别解释，直接来一个冷淡提意见的表情包。"
if [[ "${QQBOT_RUN_VOICE_SMOKE:-0}" == "1" || "${QQ_VOICE_OUTPUT_ENABLED:-}" == "true" ]]; then
  run_case_retry "语音" "voice" "plugin" \
    "请用语音跟我说一句晚安，只说四个字。" \
    "只发一条语音，不要文字，内容是四个字的晚安。"
else
  echo "=== CASE: 语音 ==="
  echo "SKIP: QQ_VOICE_OUTPUT_ENABLED is not true (set QQBOT_RUN_VOICE_SMOKE=1 to force)."
  echo
fi

echo "All chat smoke cases passed."
