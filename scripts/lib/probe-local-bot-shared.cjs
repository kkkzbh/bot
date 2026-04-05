const DEFAULT_PROBE_GROUP_ID = '829573670'
const DEFAULT_PROBE_GROUP_NAME = 'codex-probe-group'
const DEFAULT_PROBE_GROUP_CARD = 'codex-probe'
const PROBE_LOCK_DIR = '/tmp/qqbot-group-probe.lock'

function normalizeVisibleContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(normalizeVisibleContent).join('')
  if (!content || typeof content !== 'object') return String(content ?? '')

  const node = content
  const type = typeof node.type === 'string' ? node.type : ''
  const attrs = node.attrs && typeof node.attrs === 'object' ? node.attrs : {}
  const data = node.data && typeof node.data === 'object' ? node.data : {}
  const merged = { ...data, ...attrs }
  const ownText =
    typeof merged.content === 'string'
      ? merged.content
      : typeof node.content === 'string'
        ? node.content
        : ''
  const childText = Array.isArray(node.children) ? node.children.map(normalizeVisibleContent).join('') : ''

  if (type === 'text') return ownText
  if (type === 'at') {
    const rawId = merged.id ?? merged.qq ?? merged.userId ?? merged.uid
    const userId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : ''
    return userId ? `@${userId}` : '@'
  }
  if (type === 'image' || type === 'img') return '（图片）'
  if (type === 'audio' || type === 'record' || type === 'voice') return '（语音）'
  if (type === 'face' || type === 'sticker') return '（表情包）'
  if (type === 'quote') return ''

  if (ownText || childText) return `${ownText}${childText}`
  return type ? `（${type}）` : ''
}

function serializePayload(content) {
  if (content == null) return content
  if (typeof content === 'string' || typeof content === 'number' || typeof content === 'boolean') {
    return content
  }
  if (Array.isArray(content)) return content.map(serializePayload)
  if (typeof content === 'object') {
    return JSON.parse(
      JSON.stringify(content, (_key, value) => {
        if (typeof value === 'function') return undefined
        if (typeof value === 'bigint') return String(value)
        return value
      }),
    )
  }
  return String(content)
}

module.exports = {
  DEFAULT_PROBE_GROUP_CARD,
  DEFAULT_PROBE_GROUP_ID,
  DEFAULT_PROBE_GROUP_NAME,
  PROBE_LOCK_DIR,
  normalizeVisibleContent,
  serializePayload,
}
