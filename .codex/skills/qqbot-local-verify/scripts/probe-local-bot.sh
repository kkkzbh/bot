#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  probe-local-bot.sh <prompt>
  printf '%s' '<prompt>' | probe-local-bot.sh

Description:
  Inject a synthetic private-message event into the locally running Koishi bot,
  capture only the reply for the fake private channel, and print a JSON result.
  The script temporarily opens Node inspector on 127.0.0.1:9229 when needed and
  closes it after the probe by default.

Environment:
  FAKE_USER_ID          Fake private chat user id (default: derived from timestamp)
  BOT_TIMEOUT_SECONDS   Max seconds to wait for reply stability (default: 40)
  QQBOT_PREPARE_DEBUG_CHAT_MODE
                       If set, prepare the fake user's debug room to this chatMode
                       before dispatching the probe message
  KEEP_INSPECTOR        Set to 1 to keep inspector open after the probe
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[error] Missing command: $1" >&2
    exit 2
  fi
}

ensure_positive_int() {
  local name="$1"
  local value="$2"
  if ! [[ "$value" =~ ^[0-9]+$ ]] || [[ "$value" -le 0 ]]; then
    echo "[error] $name must be a positive integer" >&2
    exit 2
  fi
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

require_cmd curl
require_cmd node
require_cmd base64

prompt=""
if [[ "$#" -gt 0 ]]; then
  prompt="$*"
elif [[ ! -t 0 ]]; then
  prompt="$(cat)"
fi

if [[ -z "$prompt" ]]; then
  echo "[error] Missing prompt." >&2
  usage >&2
  exit 2
fi

timeout_seconds="${BOT_TIMEOUT_SECONDS:-40}"
keep_inspector="${KEEP_INSPECTOR:-0}"
ensure_positive_int "BOT_TIMEOUT_SECONDS" "$timeout_seconds"

if [[ -z "${FAKE_USER_ID:-}" ]]; then
  fake_user_id="9$(date +%s%N | cut -c1-9)"
else
  fake_user_id="$FAKE_USER_ID"
fi

if ! [[ "$fake_user_id" =~ ^[0-9]+$ ]]; then
  echo "[error] FAKE_USER_ID must be numeric." >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../../.." && pwd)"
cd "$repo_root"

if [[ -n "${QQBOT_PREPARE_DEBUG_CHAT_MODE:-}" ]]; then
  FAKE_USER_ID="$fake_user_id" bash "$repo_root/scripts/prepare-debug-chat-state.sh" "$QQBOT_PREPARE_DEBUG_CHAT_MODE" >/dev/null
fi

worker_pid="$(ps -ef | awk '/koishi\/lib\/worker/ && !/awk/ {print $2; exit}')"
if [[ -z "$worker_pid" ]]; then
  echo "[error] Failed to find local Koishi worker pid." >&2
  exit 1
fi

opened_inspector=0
if ! curl -fsS http://127.0.0.1:9229/json/list >/dev/null 2>&1; then
  kill -USR1 "$worker_pid"
  opened_inspector=1
  for _ in $(seq 1 50); do
    if curl -fsS http://127.0.0.1:9229/json/list >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

if ! curl -fsS http://127.0.0.1:9229/json/list >/dev/null 2>&1; then
  echo "[error] Inspector did not become available on 127.0.0.1:9229." >&2
  exit 1
fi

prompt_b64="$(printf '%s' "$prompt" | base64 | tr -d '\n')"
probe_started_at="$(date +%s%3N)"

probe_json="$(
  QQBOT_TEST_PROMPT_B64="$prompt_b64" \
  QQBOT_FAKE_USER_ID="$fake_user_id" \
  QQBOT_TIMEOUT_SECONDS="$timeout_seconds" \
  QQBOT_KEEP_INSPECTOR="$keep_inspector" \
  QQBOT_OPENED_INSPECTOR="$opened_inspector" \
  node <<'NODE'
const http = require('http')

const prompt = Buffer.from(process.env.QQBOT_TEST_PROMPT_B64 || '', 'base64').toString('utf8')
const fakeUserId = Number(process.env.QQBOT_FAKE_USER_ID || '0')
const timeoutSeconds = Number(process.env.QQBOT_TIMEOUT_SECONDS || '40')
const keepInspector = process.env.QQBOT_KEEP_INSPECTOR === '1'
const openedInspector = process.env.QQBOT_OPENED_INSPECTOR === '1'

if (!prompt) {
  console.error('[error] Empty prompt after base64 decode.')
  process.exit(2)
}

if (!Number.isFinite(fakeUserId) || fakeUserId <= 0) {
  console.error('[error] Invalid fake user id.')
  process.exit(2)
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (error) {
          reject(error)
        }
      })
    }).on('error', reject)
  })
}

async function main() {
  const targets = await getJson('http://127.0.0.1:9229/json/list')
  const target = targets.find((item) => item.webSocketDebuggerUrl)
  if (!target) {
    throw new Error('no inspector target found')
  }

  const consolePkg = require.resolve('@koishijs/plugin-console/package.json', { paths: [process.cwd()] })
  const WebSocket = require(require.resolve('ws', { paths: [consolePkg, process.cwd()] }))
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map()
  let seq = 0

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString())
    if (!msg.id) return
    const task = pending.get(msg.id)
    if (!task) return
    pending.delete(msg.id)
    if (msg.error) {
      task.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      return
    }
    task.resolve(msg.result)
  })

  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  try {
    await send('Runtime.enable')

    const proto = await send('Runtime.evaluate', {
      expression:
        "(() => { const m = process.mainModule.require('@koishijs/loader'); const C = m.default || m; return C.prototype })()",
    })
    const queried = await send('Runtime.queryObjects', {
      prototypeObjectId: proto.result.objectId,
    })
    const props = await send('Runtime.getProperties', {
      objectId: queried.objects.objectId,
      ownProperties: true,
    })
    const loader = props.result.find((item) => item.name === '0')?.value?.objectId
    if (!loader) {
      throw new Error('failed to resolve loader instance')
    }

    const call = await send('Runtime.callFunctionOn', {
      objectId: loader,
      functionDeclaration: `async function(input, fakeUserId, timeoutSeconds) {
        try {
          const { OneBot } = process.mainModule.require('koishi-plugin-adapter-onebot')
          const dispatchSession = OneBot && OneBot.dispatchSession
          if (typeof dispatchSession !== 'function') {
            return JSON.stringify({
              ok: false,
              error: 'dispatchSession missing',
              adapterKeys: OneBot ? Object.keys(OneBot) : null,
            })
          }

          const rawBots = this.app && this.app.bots
          const bots = Array.isArray(rawBots) ? rawBots : Object.values(rawBots || {})
          const bot = bots.find((item) => item.platform === 'onebot')
          if (!bot) {
            return JSON.stringify({ ok: false, error: 'onebot bot not found' })
          }

          const fakeChannelId = 'private:' + fakeUserId
          const captures = []
          const normalize = (content) => {
            if (typeof content === 'string') return content
            if (Array.isArray(content)) return content.map(normalize).join('')
            if (!content || typeof content !== 'object') return String(content)
            if (typeof content.type === 'string' && content.data && typeof content.data === 'object') {
              return JSON.stringify(content)
            }
            if (typeof content.attrs?.content === 'string') return content.attrs.content
            if (typeof content.content === 'string') return content.content
            return JSON.stringify(content)
          }

          const originalSendMessage = bot.sendMessage
          const originalSendPrivateMsg = bot.internal && typeof bot.internal.sendPrivateMsg === 'function'
            ? bot.internal.sendPrivateMsg
            : null
          const originalRequest = bot.internal && typeof bot.internal._request === 'function'
            ? bot.internal._request
            : null
          bot.sendMessage = async function(channelId, content, guildId, options) {
            if (channelId === fakeChannelId) {
              captures.push({
                channelId,
                guildId: guildId ?? null,
                content: normalize(content),
                at: Date.now(),
              })
              return ['debug-' + captures.length]
            }
            return originalSendMessage.call(this, channelId, content, guildId, options)
          }

          if (originalSendPrivateMsg) {
            bot.internal.sendPrivateMsg = async function(userId, message, autoEscape) {
              if (String(userId) === String(fakeUserId)) {
                captures.push({
                  channelId: fakeChannelId,
                  guildId: null,
                  content: normalize(message),
                  at: Date.now(),
                })
                return 'debug-private'
              }
              return originalSendPrivateMsg.call(this, userId, message, autoEscape)
            }
          }

          if (originalRequest) {
            bot.internal._request = async function(action, params) {
              if (
                action === 'send_private_msg' &&
                params &&
                String(params.user_id) === String(fakeUserId)
              ) {
                captures.push({
                  channelId: fakeChannelId,
                  guildId: null,
                  content: normalize(params.message),
                  at: Date.now(),
                })
                return { message_id: 'debug-private-request' }
              }
              return originalRequest.call(this, action, params)
            }
          }

          try {
            await dispatchSession(bot, {
              post_type: 'message',
              message_type: 'private',
              sub_type: 'friend',
              self_id: Number(bot.selfId),
              user_id: fakeUserId,
              message_id: Date.now(),
              time: Math.floor(Date.now() / 1000),
              message: input,
              raw_message: input,
              font: 0,
              sender: { user_id: fakeUserId, nickname: 'codex-debug' },
            })

            const deadline = Date.now() + timeoutSeconds * 1000
            let lastCount = captures.length
            let stableSince = Date.now()
            while (Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 500))
              if (captures.length !== lastCount) {
                lastCount = captures.length
                stableSince = Date.now()
              } else if (captures.length > 0 && Date.now() - stableSince >= 6000) {
                break
              }
            }

            const messages = captures.map((item) => item.content)
            return JSON.stringify({
              ok: true,
              input,
              fakeChannelId,
              bot: {
                sid: bot.sid,
                selfId: bot.selfId,
                platform: bot.platform,
              },
              captureCount: captures.length,
              messages,
              combined: messages.join('\\n'),
              captures,
              timeout: captures.length === 0,
            })
          } finally {
            bot.sendMessage = originalSendMessage
            if (originalSendPrivateMsg) {
              bot.internal.sendPrivateMsg = originalSendPrivateMsg
            }
            if (originalRequest) {
              bot.internal._request = originalRequest
            }
          }
        } catch (error) {
          return JSON.stringify({
            ok: false,
            error: String((error && error.stack) || error),
          })
        }
      }`,
      arguments: [
        { value: prompt },
        { value: fakeUserId },
        { value: timeoutSeconds },
      ],
      awaitPromise: true,
      returnByValue: true,
    })

    const raw = call.result.value
    if (typeof raw !== 'string') {
      throw new Error('unexpected probe result shape')
    }

    process.stdout.write(raw + '\n')

    if (openedInspector && !keepInspector) {
      try {
        await send('Runtime.evaluate', {
          expression: "process.mainModule.require('inspector').close()",
        })
      } catch {}
    }
  } finally {
    ws.close()
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String((error && error.stack) || error) }))
  process.exit(1)
})
NODE
)"

capture_count="$(
  printf '%s' "$probe_json" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const parsed=JSON.parse(data);process.stdout.write(String(parsed.captureCount ?? 0));});"
)"
timeout_flag="$(
  printf '%s' "$probe_json" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const parsed=JSON.parse(data);process.stdout.write(parsed.timeout ? 'true' : 'false');});"
)"

if [[ "$capture_count" -gt 0 && "$timeout_flag" != "true" ]]; then
  printf '%s\n' "$probe_json"
  exit 0
fi

trace_deadline=$(( $(date +%s) + timeout_seconds ))
trace_payload=""
while (( $(date +%s) < trace_deadline )); do
  traces_json="$(curl -fsS 'http://127.0.0.1:5140/trace/api/traces?limit=20' 2>/dev/null || true)"
  if [[ -n "$traces_json" ]]; then
    trace_payload="$(
      TRACE_JSON="$traces_json" \
      TRACE_FAKE_USER_ID="$fake_user_id" \
      TRACE_PROMPT="$prompt" \
      TRACE_STARTED_AT="$probe_started_at" \
      node <<'NODE'
const payload = JSON.parse(process.env.TRACE_JSON || '{"traces":[]}')
const fakeUserId = String(process.env.TRACE_FAKE_USER_ID || '')
const prompt = String(process.env.TRACE_PROMPT || '')
const startedAt = Number(process.env.TRACE_STARTED_AT || '0')
const traces = Array.isArray(payload.traces) ? payload.traces : []
const match = traces.find((trace) => {
  if (String(trace.userId ?? '') !== fakeUserId) return false
  if (String(trace.channelId ?? '') !== `private:${fakeUserId}`) return false
  if (String(trace.inputPreview ?? '') !== prompt) return false
  if (Number(trace.createdAt ?? 0) + 1000 < startedAt) return false
  return true
})
process.stdout.write(match ? JSON.stringify(match) : '')
NODE
    )"
    if [[ -n "$trace_payload" ]]; then
      trace_status="$(
        TRACE_MATCH="$trace_payload" node -e "const parsed=JSON.parse(process.env.TRACE_MATCH||'{}');process.stdout.write(String(parsed.status||''));"
      )"
      trace_reply="$(
        TRACE_MATCH="$trace_payload" node -e "const parsed=JSON.parse(process.env.TRACE_MATCH||'{}');process.stdout.write(String(parsed.finalReplyPreview||''));"
      )"
      if [[ "$trace_status" != "running" && -n "$trace_reply" ]]; then
        merged_json="$(
          PROBE_JSON="$probe_json" TRACE_MATCH="$trace_payload" node <<'NODE'
const probe = JSON.parse(process.env.PROBE_JSON || '{}')
const trace = JSON.parse(process.env.TRACE_MATCH || '{}')
probe.timeout = false
probe.trace = {
  traceId: trace.traceId ?? null,
  status: trace.status ?? null,
  model: trace.model ?? null,
  finalReplyPreview: trace.finalReplyPreview ?? null,
  conversationId: trace.conversationId ?? null,
  updatedAtText: trace.updatedAtText ?? null,
}
if ((!Array.isArray(probe.messages) || probe.messages.length === 0) && trace.finalReplyPreview) {
  probe.messages = [trace.finalReplyPreview]
  probe.combined = trace.finalReplyPreview
}
process.stdout.write(JSON.stringify(probe))
NODE
        )"
        printf '%s\n' "$merged_json"
        exit 0
      fi
    fi
  fi
  sleep 1
done

printf '%s\n' "$probe_json"
exit 1
