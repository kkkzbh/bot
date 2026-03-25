// ─── Label maps ───────────────────────────────────────────────────────────────

export const FIELD_LABELS: Record<string, string> = {
  QQ_VOICE_ENABLED: 'QQ 语音总开关',
  QQ_VOICE_INPUT_ENABLED: '语音转文字',
  QQ_VOICE_OUTPUT_ENABLED: '语音回复',
  CHAT_NATURAL_TRIGGER_ENABLED: '群聊自然触发',
  TASK_AUTOMATION_INTENT_ENABLED: '任务意图识别',
  QQBOT_REPLY_INTERRUPT_ENABLED: '回复期中断',
  CHATLUNA_COMMON_FS: '文件系统工具总开关',
  CHATLUNA_COMMON_FS_SCOPE_PATH: '文件系统作用域目录',
  CHATLUNA_BASE_URL: '对话模型接口地址',
  CHATLUNA_API_KEY: '对话模型接口密钥',
  CHATLUNA_DEFAULT_MODEL: '对话默认模型',
  OPENAI_BASE_URL: '通用模型接口地址',
  OPENAI_API_KEY: '通用模型接口密钥',
  OPENAI_MODEL: '通用默认模型',
  TASK_AUTOMATION_INTENT_MODEL: '任务意图模型',
  TASK_AUTOMATION_DELIVERY_MODEL: '任务投递模型',
  TASK_AUTOMATION_CHAT_REPLY_MODEL: '任务回复模型',
  CHATLUNA_DEFAULT_PRESET: '默认预设',
  CHAT_ENABLED_GROUPS: '自动化启用群',
  CHAT_NATURAL_TRIGGER_GROUPS: '自然触发群',
  CHAT_NATURAL_TRIGGER_ALIASES: '触发别名',
  CHATLUNA_COMMAND_AUTHORITY: '命令权限等级',
}

export const FIELD_HINTS: Record<string, string> = {
  CHATLUNA_BASE_URL:
    '普通聊天默认走这里配置的接口地址。它只影响 ChatLuna 主聊天链路，不会覆盖任务自动化、自然触发判定和记忆抽取。',
  CHATLUNA_API_KEY:
    '普通聊天默认走这里配置的接口密钥。主聊天切换供应商时，优先改这里，不要直接改 OPENAI_*。',
  TASK_AUTOMATION_INTENT_MODEL:
    '用于识别一段消息是不是任务需求，以及应该进入哪条任务自动化链路。更适合选择理解能力强、分类稳定的模型。',
  TASK_AUTOMATION_DELIVERY_MODEL:
    '用于把已识别的任务整理成可执行指令并投递给后续流程。更适合选择结构化输出稳定、遵循要求准确的模型。',
  TASK_AUTOMATION_CHAT_REPLY_MODEL:
    '用于任务流程里的对话回复，例如确认、追问和结果回执。它会直接影响用户看到的任务类回复内容。',
  CHATLUNA_COMMON_FS:
    '控制是否向 ChatLuna 注入整组 file_* 文件系统能力。关闭后，下方文件系统工具即使策略设为启用，也不会真正提供给模型。',
  CHATLUNA_COMMON_FS_SCOPE_PATH:
    '限制文件系统工具默认可访问的根目录。留空时会跟随 Koishi 启动目录，也就是当前 bot 的工作目录。',
  CHATLUNA_DEFAULT_MODEL:
    '普通聊天默认走这里配置的模型。建议填写完整规范名，例如 siliconflow/Pro/moonshotai/Kimi-K2.5。',
}

export const ROLE_LABELS: Record<string, string> = {
  system: '系统',
  user: '用户',
  assistant: '助手',
  tool: '工具',
}

export const SERVICE_LABELS: Record<string, string> = {
  'qqbot.target': '机器人总控',
  'qqbot-koishi.service': '主机器人服务',
  'qqbot-stack.service': '依赖服务栈',
  'qqbot-voice-tts.service': '语音合成服务',
  'qqbot-voice-tts-tailnet.service': '语音 Tailnet 发布',
}

export const SERVICE_HINTS: Record<string, string> = {
  'qqbot.target':
    '整套本地链路总控，用于一键启动、停止或全栈重启主机器人和依赖服务。',
  'qqbot-koishi.service': '机器人主程序。大多数聊天和控制功能依赖它。',
  'qqbot-stack.service': '依赖组件服务。桥接、外部接口或容器能力需要它。',
  'qqbot-voice-tts.service': '只有用到语音播报或语音回复时才需要。',
  'qqbot-voice-tts-tailnet.service':
    '仅在服务器需要经由 Tailnet 访问本机 TTS 时启用。它不会再启动第二份模型。',
}

export const VISIBLE_SERVICE_UNITS = [
  'qqbot.target',
  'qqbot-voice-tts.service',
  'qqbot-voice-tts-tailnet.service',
] as const

export const ALL_SERVICE_UNITS = [
  'qqbot.target',
  'qqbot-koishi.service',
  'qqbot-stack.service',
  'qqbot-voice-tts.service',
  'qqbot-voice-tts-tailnet.service',
] as const

export const ACTIVE_STATE_LABELS: Record<string, string> = {
  active: '已运行',
  inactive: '未运行',
  failed: '运行失败',
  activating: '正在启动',
  deactivating: '正在停止',
  reloading: '正在重载',
  unknown: '未知',
}

export const SUB_STATE_LABELS: Record<string, string> = {
  active: '已激活',
  running: '运行中',
  dead: '未运行',
  exited: '已退出',
  failed: '失败',
  start: '启动中',
  stop: '停止中',
  auto_restart: '自动重启中',
  listening: '监听中',
  plugged: '已接入',
  mounted: '已挂载',
  unknown: '未知',
}

export const UNIT_FILE_STATE_LABELS: Record<string, string> = {
  enabled: '已启用开机自启',
  disabled: '未启用开机自启',
  static: '固定服务',
  indirect: '间接启用',
  masked: '已屏蔽',
  generated: '自动生成',
  transient: '临时服务',
  unknown: '未知',
}

/** Items shown in the Overview panel's features chip list. */
export const OVERVIEW_FEATURE_ITEMS: [string, string][] = [
  ['QQ_VOICE_ENABLED', '语音'],
  ['CHAT_NATURAL_TRIGGER_ENABLED', '自然触发'],
  ['TASK_AUTOMATION_INTENT_ENABLED', '任务意图'],
  ['QQBOT_REPLY_INTERRUPT_ENABLED', '回复期中断'],
]

// ─── Lookup helpers ───────────────────────────────────────────────────────────

export function getFieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key
}

export function getFieldHint(key: string): string {
  return FIELD_HINTS[key] ?? ''
}

export function getServiceLabel(unit: string, fallbackDescription?: string): string {
  return SERVICE_LABELS[unit] ?? fallbackDescription ?? unit
}

export function getServiceHint(unit: string): string {
  return SERVICE_HINTS[unit] ?? '这是机器人运行过程中的一个服务组件。'
}

export function getActiveStateLabel(value: string): string {
  return ACTIVE_STATE_LABELS[value] ?? value
}

export function getSubStateLabel(value: string): string {
  return SUB_STATE_LABELS[value] ?? value
}

export function getUnitFileStateLabel(value: string): string {
  return UNIT_FILE_STATE_LABELS[value] ?? value
}

// ─── Tone / status helpers ────────────────────────────────────────────────────

export type StatusTone = 'success' | 'warning' | 'danger' | 'muted' | 'primary'

/**
 * Maps a systemd activeState to a badge tone.
 */
export function getActiveStateTone(activeState: string): StatusTone {
  switch (activeState) {
    case 'active':
      return 'success'
    case 'failed':
      return 'danger'
    case 'activating':
    case 'deactivating':
    case 'reloading':
      return 'warning'
    default:
      return 'muted'
  }
}

/**
 * Maps a systemd activeState to the CSS class suffix used on `.bc-status-dot`.
 * Returns one of: 'active' | 'failed' | 'inactive'
 */
export function getStatusDotClass(activeState: string): 'active' | 'failed' | 'inactive' {
  if (activeState === 'active') return 'active'
  if (activeState === 'failed') return 'failed'
  return 'inactive'
}

/**
 * Returns the label for the auto-start toggle button based on current state.
 */
export function getAutoStartButtonLabel(canEnable: boolean): string {
  return canEnable ? '启用开机自启' : '已启用开机自启'
}
