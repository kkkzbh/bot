#!/bin/ash
set -euo pipefail

cd /app/llbot

FILE="default_config.json"
WEBUI_PORT="${WEBUI_PORT:-3080}"
LLONEBOT_WS_PORT="${LLONEBOT_WS_PORT:-3001}"
PMHQ_HOST="${pmhq_host:-${PMHQ_HOST:-host.containers.internal}}"
PMHQ_PORT="${pmhq_port:-${PMHQ_PORT:-13000}}"

node <<'EOF_NODE'
const { readFileSync, writeFileSync } = require('node:fs')

const file = 'default_config.json'
const config = JSON.parse(readFileSync(file, 'utf8'))
const ws = config.ob11?.connect?.find((item) => item.type === 'ws')

if (!ws) {
  throw new Error('Missing ob11 ws config in default_config.json')
}

config.webui = {
  ...config.webui,
  enable: true,
  host: '',
  port: Number(process.env.WEBUI_PORT || '3080'),
}

ws.enable = true
ws.host = '0.0.0.0'
ws.port = Number(process.env.LLONEBOT_WS_PORT || '3001')
ws.token = process.env.ONEBOT_TOKEN || ''

config.ffmpeg = '/usr/bin/ffmpeg'

writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)

const bundleFile = 'llbot.js'
let bundle = readFileSync(bundleFile, 'utf8')
const loginTimeoutPatches = [
  {
    from: 'return await invoke("nodeIKernelLoginService/getLoginList", []);',
    to: 'return await invoke("nodeIKernelLoginService/getLoginList", [], { timeout: 6e4 });',
  },
  {
    from: 'return await invoke("nodeIKernelLoginService/getQRCodePicture", [], { resultCmd: ReceiveCmdS.LOGIN_QR_CODE });',
    to: 'return await invoke("nodeIKernelLoginService/getQRCodePicture", [], { resultCmd: ReceiveCmdS.LOGIN_QR_CODE, timeout: 6e4 });',
  },
]

for (const patch of loginTimeoutPatches) {
  if (!bundle.includes(patch.from)) {
    throw new Error(`Missing llbot.js patch target: ${patch.from}`)
  }
  bundle = bundle.replace(patch.from, patch.to)
}

writeFileSync(bundleFile, bundle)
EOF_NODE

mkdir -p /app/llbot/data

exec node --enable-source-maps ./llbot.js \
  "--pmhq-host=${PMHQ_HOST}" \
  "--pmhq-port=${PMHQ_PORT}"
