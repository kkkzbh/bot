#!/bin/ash
set -euo pipefail

cd /app/llbot

FILE="default_config.json"
WEBUI_PORT="${WEBUI_PORT:-3080}"
LLONEBOT_WS_PORT="${LLONEBOT_WS_PORT:-3001}"
LLONEBOT_DISABLE_WEBUI_AUTH="${LLONEBOT_DISABLE_WEBUI_AUTH:-false}"
PMHQ_HOST="${pmhq_host:-${PMHQ_HOST:-pmhq}}"
PMHQ_PORT="${pmhq_port:-${PMHQ_PORT:-13000}}"

node <<'EOF_NODE'
const { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const file = 'default_config.json'
const dataDir = '/app/llbot/data'
const llbotEntrypoint = '/app/llbot/llbot.js'
const disableWebUIAuth = /^(1|true|yes|on)$/i.test(process.env.LLONEBOT_DISABLE_WEBUI_AUTH || '')

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

function disableWebUIAuthMiddleware() {
  if (!disableWebUIAuth) {
    return
  }

  const source = readFileSync(llbotEntrypoint, 'utf8')
  const startMarker = 'function authMiddleware(req, res, next) {'
  const endMarker = '\n//#endregion\n//#region src/webui/BE/utils.ts'
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)

  if (start === -1 || end === -1) {
    throw new Error('Failed to locate llbot WebUI auth middleware')
  }

  const replacement = `${startMarker}\n\tnext();\n}`
  writeFileSync(llbotEntrypoint, `${source.slice(0, start)}${replacement}${source.slice(end)}`)

  const tokenPath = join(dataDir, 'webui_token.txt')
  if (existsSync(tokenPath)) {
    rmSync(tokenPath)
  }
}

writeManagedConfig(file)

if (existsSync(dataDir)) {
  const accountConfigNames = readdirSync(dataDir).filter((name) => /^config_\d+\.json$/.test(name))
  for (const name of accountConfigNames) {
    writeManagedConfig(join(dataDir, name))
  }
}

disableWebUIAuthMiddleware()
EOF_NODE

mkdir -p /app/llbot/data

exec node --enable-source-maps ./llbot.js \
  "--pmhq-host=${PMHQ_HOST}" \
  "--pmhq-port=${PMHQ_PORT}"
