#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT_DIR = process.cwd()
loadDotenv(resolveBotEnvPath())

const STICKER_DIR = process.env.CHATLUNA_STICKER_DIR || './data/chathub/stickers'
const INDEXER_BASE_URL = process.env.STICKER_INDEXER_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3'
const INDEXER_API_KEY = process.env.STICKER_INDEXER_API_KEY || ''
const INDEXER_MODEL = process.env.STICKER_INDEXER_MODEL || 'doubao-seed-2-0-mini-260215'
const INDEXER_TIMEOUT_MS = Number(process.env.STICKER_INDEXER_TIMEOUT_MS || 60000)
const CATALOG_PATH = path.resolve(ROOT_DIR, STICKER_DIR, 'catalog.generated.json')
const IMAGE_ROOT = path.resolve(ROOT_DIR, STICKER_DIR, 'images')
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

function resolveBotEnvPath() {
  const explicit = String(process.env.QQBOT_ENV_FILE || '').trim()
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(ROOT_DIR, explicit)
  }

  const localEnv = path.resolve(ROOT_DIR, '.env.local')
  if (existsSync(localEnv)) return localEnv

  const serverEnv = path.resolve(ROOT_DIR, '.env.server')
  if (existsSync(serverEnv)) return serverEnv

  return path.resolve(ROOT_DIR, '.env.local')
}

function loadDotenv(envPath) {
  if (!existsSync(envPath)) return

  const lines = readFileSync(envPath, 'utf-8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index < 0) continue

    const key = trimmed.slice(0, index).trim()
    if (!key || process.env[key] != null) continue

    const rawValue = trimmed.slice(index + 1).trim()
    process.env[key] = stripQuotes(rawValue)
  }
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function mimeFromExtension(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    default:
      return 'image/png'
  }
}

function toSlugLabel(filePath) {
  return path
    .basename(filePath, path.extname(filePath))
    .replace(/[_-]+/g, ' ')
    .trim()
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function extractFirstJsonObject(raw) {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return trimmed.slice(start, end + 1)
}

function normalizeStringArray(value, fallback = []) {
  if (!Array.isArray(value)) return fallback
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
}

function createFallbackMetadata(relativePath) {
  const label = toSlugLabel(relativePath) || '表情包'
  return {
    caption: label,
    keywords: [label],
    moods: [label],
    scenes: [],
    historyLabel: label,
    confidence: 0.1,
  }
}

async function listFiles(dirPath) {
  if (!existsSync(dirPath)) return []
  const entries = await readdir(dirPath, { withFileTypes: true })
  const results = []
  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await listFiles(absolutePath)))
      continue
    }
    if (!SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    results.push(absolutePath)
  }
  return results
}

function resolveScopes(absolutePath) {
  const relative = path.relative(IMAGE_ROOT, absolutePath).replaceAll(path.sep, '/')
  if (relative.startsWith('global/')) {
    return ['global']
  }

  const matched = relative.match(/^personas\/([^/]+)\//)
  if (matched?.[1]) {
    return [`persona:${matched[1].trim()}`]
  }

  throw new Error(`unsupported sticker scope path: ${relative}`)
}

async function readExistingCatalog() {
  if (!existsSync(CATALOG_PATH)) return new Map()

  try {
    const parsed = JSON.parse(await readFile(CATALOG_PATH, 'utf-8'))
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    return new Map(entries.map((entry) => [String(entry.file || ''), entry]))
  } catch {
    return new Map()
  }
}

async function describeImageWithModel({ absolutePath, relativePath, mime }) {
  if (!INDEXER_API_KEY) {
    return createFallbackMetadata(relativePath)
  }

  const bytes = await readFile(absolutePath)
  const dataUri = `data:${mime};base64,${bytes.toString('base64')}`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), INDEXER_TIMEOUT_MS)

  try {
    const response = await fetch(`${INDEXER_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${INDEXER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: INDEXER_MODEL,
        temperature: 0,
        max_tokens: 512,
        messages: [
          {
            role: 'system',
            content:
              '你是一个表情包索引器。请阅读图片并输出 JSON 对象，不要输出 markdown，不要输出解释。JSON 字段固定为 caption, keywords, moods, scenes, historyLabel, confidence。',
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  '请为这张二次元聊天表情包生成检索元数据。要求：caption 为一句简短概括；keywords/moods/scenes 各给 2 到 6 个短语；historyLabel 给一个非常短的中文标签；confidence 为 0 到 1 的小数。只返回 JSON 对象。',
              },
              {
                type: 'image_url',
                image_url: { url: dataUri },
              },
            ],
          },
        ],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`status=${response.status}`)
    }

    const payload = await response.json()
    const content = payload?.choices?.[0]?.message?.content
    const jsonText = extractFirstJsonObject(content)
    if (!jsonText) {
      throw new Error('model returned no json object')
    }

    const parsed = JSON.parse(jsonText)
    const fallback = createFallbackMetadata(relativePath)
    return {
      caption: String(parsed.caption || fallback.caption).trim() || fallback.caption,
      keywords: normalizeStringArray(parsed.keywords, fallback.keywords),
      moods: normalizeStringArray(parsed.moods, fallback.moods),
      scenes: normalizeStringArray(parsed.scenes, fallback.scenes),
      historyLabel: String(parsed.historyLabel || fallback.historyLabel).trim() || fallback.historyLabel,
      confidence: Number.isFinite(parsed.confidence) ? Number(parsed.confidence) : fallback.confidence,
    }
  } catch (error) {
    console.warn(`[stickers:sync] metadata fallback for ${relativePath}: ${error.message}`)
    return createFallbackMetadata(relativePath)
  } finally {
    clearTimeout(timeout)
  }
}

async function main() {
  const existingByFile = await readExistingCatalog()
  const files = await listFiles(IMAGE_ROOT)
  const entries = []

  for (const absolutePath of files.sort()) {
    const relativePath = path.relative(path.resolve(ROOT_DIR, STICKER_DIR), absolutePath).replaceAll(path.sep, '/')
    const fileBuffer = await readFile(absolutePath)
    const hash = sha256(fileBuffer)
    const existing = existingByFile.get(relativePath)
    if (existing?.hash === hash) {
      entries.push(existing)
      console.log(`[stickers:sync] reuse ${relativePath}`)
      continue
    }

    const mime = mimeFromExtension(absolutePath)
    const metadata = await describeImageWithModel({ absolutePath, relativePath, mime })
    entries.push({
      id: path.basename(relativePath, path.extname(relativePath)),
      file: relativePath,
      hash,
      mime,
      scopes: resolveScopes(absolutePath),
      caption: metadata.caption,
      keywords: metadata.keywords,
      moods: metadata.moods,
      scenes: metadata.scenes,
      historyLabel: metadata.historyLabel,
      confidence: metadata.confidence,
    })
    console.log(`[stickers:sync] indexed ${relativePath}`)
  }

  await mkdir(path.dirname(CATALOG_PATH), { recursive: true })
  await writeFile(
    CATALOG_PATH,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        model: INDEXER_MODEL,
        entries: entries.sort((left, right) => String(left.file).localeCompare(String(right.file))),
      },
      null,
      2,
    ) + '\n',
  )
  console.log(`[stickers:sync] wrote ${CATALOG_PATH}`)
}

main().catch((error) => {
  console.error(`[stickers:sync] failed: ${error.stack || error.message}`)
  process.exitCode = 1
})
