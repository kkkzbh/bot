#!/bin/ash
set -euo pipefail

cd /app/llbot

FILE="default_config.json"
WEBUI_PORT="${WEBUI_PORT:-3080}"
LLONEBOT_WS_PORT="${LLONEBOT_WS_PORT:-3001}"
PMHQ_HOST="${pmhq_host:-${PMHQ_HOST:-pmhq}}"
PMHQ_PORT="${pmhq_port:-${PMHQ_PORT:-13000}}"

node <<'EOF_NODE'
const { existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const file = 'default_config.json'
const dataDir = '/app/llbot/data'

function applyManagedConfig(config) {
  const ws = config.ob11?.connect?.find((item) => item.type === 'ws')
  if (!ws) {
    throw new Error('Missing ob11 ws config in managed llonebot config')
  }

  config.webui = {
    ...config.webui,
    enable: true,
    host: '',
    port: Number(process.env.WEBUI_PORT || '3080'),
  }

  config.ob11 = {
    ...config.ob11,
    enable: true,
  }

  ws.enable = true
  ws.host = '0.0.0.0'
  ws.port = Number(process.env.LLONEBOT_WS_PORT || '3001')
  ws.token = process.env.ONEBOT_TOKEN || ''

  for (const item of config.ob11?.connect || []) {
    if (item.type === 'ws-reverse') {
      item.enable = false
      item.url = ''
      item.token = ''
    }
    if (item.type === 'http') {
      item.enable = false
      item.host = '127.0.0.1'
      item.token = ''
    }
    if (item.type === 'http-post') {
      item.enable = false
      item.url = ''
      item.token = ''
    }
  }

  config.ffmpeg = '/usr/bin/ffmpeg'
  return config
}

function writeManagedConfig(filePath) {
  const config = JSON.parse(readFileSync(filePath, 'utf8'))
  writeFileSync(filePath, `${JSON.stringify(applyManagedConfig(config), null, 2)}\n`)
}

writeManagedConfig(file)

if (existsSync(dataDir)) {
  const accountConfigNames = readdirSync(dataDir).filter((name) => /^config_\d+\.json$/.test(name))
  for (const name of accountConfigNames) {
    writeManagedConfig(join(dataDir, name))
  }
}
EOF_NODE

mkdir -p /app/llbot/data

exec node --enable-source-maps ./llbot.js \
  "--pmhq-host=${PMHQ_HOST}" \
  "--pmhq-port=${PMHQ_PORT}"
