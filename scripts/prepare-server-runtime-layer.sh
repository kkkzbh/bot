#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${DEPLOY_APP_DIR:-$(cd -- "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SHARED_DIR="${QQBOT_SHARED_DIR:-$(dirname "${APP_DIR}")/shared}"
RUNTIME_ENV_FILE="${SHARED_DIR}/.env.runtime"
BASE_ENV_FILE="${QQBOT_SERVER_ENV_FILE:-${SHARED_DIR}/.env.server}"
LEGACY_BASE_ENV_FILE="${APP_DIR}/.env.server"
RUNTIME_PRESET_DIR="${SHARED_DIR}/presets"
RUNTIME_LLBOT_DIR="${SHARED_DIR}/llonebot"
RUNTIME_LLBOT_RUNTIME_DIR="${SHARED_DIR}/llbot-runtime"
BUNDLED_PRESET_DIR="${APP_DIR}/data/chathub/presets"
LEGACY_LLBOT_DIR="${APP_DIR}/data/llonebot"
SEED_MARKER_FILE="${SHARED_DIR}/.runtime-layer.seeded"

mkdir -p "${SHARED_DIR}" "${RUNTIME_PRESET_DIR}" "${RUNTIME_LLBOT_DIR}" "${RUNTIME_LLBOT_RUNTIME_DIR}"
chmod 700 "${SHARED_DIR}" "${RUNTIME_PRESET_DIR}" "${RUNTIME_LLBOT_DIR}" "${RUNTIME_LLBOT_RUNTIME_DIR}"

upsert_env_value() {
  local key="$1"
  local value="$2"
  local temp_file
  temp_file="$(mktemp)"

  node - "${RUNTIME_ENV_FILE}" "${temp_file}" "${key}" "${value}" <<'NODE'
const fs = require('node:fs')

const [, , sourcePath, targetPath, key, value] = process.argv
const prefix = `${key}=`
const lines = fs.existsSync(sourcePath)
  ? fs.readFileSync(sourcePath, 'utf8').split(/\r?\n/)
  : []

let replaced = false
const next = []

for (const line of lines) {
  if (!line && next.length === lines.length - 1) continue
  if (line.startsWith(prefix)) {
    if (!replaced) {
      next.push(`${key}=${value}`)
      replaced = true
    }
    continue
  }
  next.push(line)
}

if (!replaced) {
  if (next.length && next[next.length - 1] !== '') {
    next.push('')
  }
  next.push(`${key}=${value}`)
}

const output = `${next.filter((line, index, array) => !(index === array.length - 1 && line === '')).join('\n')}\n`
fs.writeFileSync(targetPath, output, 'utf8')
NODE

  mv "${temp_file}" "${RUNTIME_ENV_FILE}"
  chmod 600 "${RUNTIME_ENV_FILE}"
}

if [[ ! -f "${RUNTIME_ENV_FILE}" ]]; then
  if [[ -f "${BASE_ENV_FILE}" ]]; then
    node - "${BASE_ENV_FILE}" "${RUNTIME_ENV_FILE}" "${APP_DIR}/src/plugins/bot-console/server.ts" <<'NODE'
const fs = require('node:fs')

const [, , sourceEnvPath, targetEnvPath, sourceFilePath] = process.argv
const sourceText = fs.readFileSync(sourceFilePath, 'utf8')
const envText = fs.readFileSync(sourceEnvPath, 'utf8')
const keyMatches = [...sourceText.matchAll(/key:\s*'([^']+)'/g)]
const managedKeys = new Set(keyMatches.map((match) => match[1]))

if (managedKeys.size === 0) {
  throw new Error(`failed to discover managed env keys from ${sourceFilePath}`)
}

const selected = new Map()
for (const line of envText.split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
  if (!match) continue
  const [, key] = match
  if (!managedKeys.has(key)) continue
  selected.set(key, line)
}

const output = [
  '# Seeded from previous .env.server during first runtime-layer migration.',
  ...selected.values(),
  '',
].join('\n')

fs.writeFileSync(targetEnvPath, output, 'utf8')
NODE
  elif [[ -f "${LEGACY_BASE_ENV_FILE}" ]]; then
    node - "${LEGACY_BASE_ENV_FILE}" "${RUNTIME_ENV_FILE}" "${APP_DIR}/src/plugins/bot-console/server.ts" <<'NODE'
const fs = require('node:fs')

const [, , sourceEnvPath, targetEnvPath, sourceFilePath] = process.argv
const sourceText = fs.readFileSync(sourceFilePath, 'utf8')
const envText = fs.readFileSync(sourceEnvPath, 'utf8')
const keyMatches = [...sourceText.matchAll(/key:\s*'([^']+)'/g)]
const managedKeys = new Set(keyMatches.map((match) => match[1]))

if (managedKeys.size === 0) {
  throw new Error(`failed to discover managed env keys from ${sourceFilePath}`)
}

const selected = new Map()
for (const line of envText.split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
  if (!match) continue
  const [, key] = match
  if (!managedKeys.has(key)) continue
  selected.set(key, line)
}

const output = [
  '# Seeded from previous release-local .env.server during runtime-layer migration.',
  ...selected.values(),
  '',
].join('\n')

fs.writeFileSync(targetEnvPath, output, 'utf8')
NODE
  else
    : > "${RUNTIME_ENV_FILE}"
  fi
  chmod 600 "${RUNTIME_ENV_FILE}"
fi

upsert_env_value "LLONEBOT_DATA_DIR" "${RUNTIME_LLBOT_DIR}"
upsert_env_value "LLBOT_RUNTIME_DIR" "${RUNTIME_LLBOT_RUNTIME_DIR}"

if [[ ! -e "${SEED_MARKER_FILE}" ]]; then
  if [[ -d "${LEGACY_LLBOT_DIR}" ]] && [[ -z "$(find "${RUNTIME_LLBOT_DIR}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
    if [[ -n "$(find "${LEGACY_LLBOT_DIR}" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
      cp -a "${LEGACY_LLBOT_DIR}/." "${RUNTIME_LLBOT_DIR}/"
    fi
  fi

  if [[ -d "${BUNDLED_PRESET_DIR}" ]]; then
    while IFS= read -r -d '' file_path; do
      cp -f "${file_path}" "${RUNTIME_PRESET_DIR}/$(basename "${file_path}")"
    done < <(
      find "${BUNDLED_PRESET_DIR}" -maxdepth 1 -type f \
        \( -name '*.yml' -o -name '*.txt' -o -name '.bot-console-preset-order.json' \) \
        -print0
    )
  fi

  touch "${SEED_MARKER_FILE}"
  chmod 600 "${SEED_MARKER_FILE}"
fi

find "${RUNTIME_PRESET_DIR}" -maxdepth 1 -type f -exec chmod 600 {} +
