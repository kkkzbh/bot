import type {
  ToolCatalogEntry,
  ToolCategoryKey,
  ToolCompatibility,
  ToolOverrideMode,
  ToolPolicyScope,
  ToolPolicyScopeKind,
  ToolRouteProfile,
  ToolRiskLevel,
} from '../types'

export const TOOL_ROUTE_PROFILES = ['agent', 'automation'] as const satisfies readonly ToolRouteProfile[]
export const TOOL_GLOBAL_DEFAULT_SCOPE_ID = 'global-default'
export const TOOL_PRIVATE_DEFAULT_SCOPE_ID = 'private-default'

export const TOOL_CATEGORY_LABELS: Record<ToolCategoryKey, string> = {
  builtin: '内置交互',
  file: '文件系统',
  web: '网页与网络',
  geo: '天气与地理',
}

export const TOOL_ROUTE_LABELS: Record<ToolRouteProfile, string> = {
  agent: 'Agent 回复',
  automation: '自动化',
}

export const TOOL_COMPATIBILITY_LABELS: Record<ToolCompatibility, string> = {
  compatible: '兼容',
  conditional: '条件兼容',
  incompatible: '不兼容',
}

export const TOOL_RISK_LABELS: Record<ToolRiskLevel, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
}

export const TOOL_SCOPE_LABELS: Record<ToolPolicyScopeKind, string> = {
  global_default: '全局默认',
  private_default: '私聊默认',
  private_conversation: '私聊会话',
  group: '群聊',
}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  {
    toolName: 'file_read',
    title: '文件读取',
    category: 'file',
    description: '从磁盘读取文件内容，用于查看配置、源码或运行产物。',
    compatibility: 'incompatible',
    compatibilityNote: '会把模型带入文件代理工作流，通常不应暴露给普通对话 persona。',
    hardDependencies: [],
    relatedTools: ['file_write', 'file_list', 'file_grep', 'file_glob', 'file_update'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'file_write',
    title: '文件写入',
    category: 'file',
    description: '向磁盘写入文本内容，适合生成或覆盖单个文件。',
    compatibility: 'incompatible',
    compatibilityNote: '这是高风险写操作工具，不应出现在agent 链路里。',
    hardDependencies: [],
    relatedTools: ['file_read', 'file_multi_write', 'file_update'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'file_list',
    title: '文件列表',
    category: 'file',
    description: '列出目录下的文件和子目录，适合浏览项目结构。',
    compatibility: 'incompatible',
    compatibilityNote: '会把模型引导到文件系统代理模式，不适合普通 ReplyPlan 会话。',
    hardDependencies: [],
    relatedTools: ['file_read', 'file_grep', 'file_glob'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'file_grep',
    title: '文件检索',
    category: 'file',
    description: '按正则在文件中搜索内容，适合定位关键词、错误和配置项。',
    compatibility: 'incompatible',
    compatibilityNote: '这是文件代理能力的一部分，agent 里容易把模型带偏。',
    hardDependencies: [],
    relatedTools: ['file_read', 'file_list', 'file_glob'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'file_glob',
    title: '文件模式匹配',
    category: 'file',
    description: '用 glob 语法查找文件，适合批量定位同类文件。',
    compatibility: 'incompatible',
    compatibilityNote: '这是文件代理工具链的一环，通常不应对普通用户开放。',
    hardDependencies: [],
    relatedTools: ['file_list', 'file_grep', 'file_read'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'file_rename',
    title: '文件重命名',
    category: 'file',
    description: '重命名单个文件或目录，适合小范围整理。',
    compatibility: 'incompatible',
    compatibilityNote: '重命名属于高风险写操作，适合后台代理，不适合普通对话。',
    hardDependencies: [],
    relatedTools: ['file_write', 'file_multi_rename', 'file_update'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'file_multi_rename',
    title: '批量重命名',
    category: 'file',
    description: '按模式批量重命名文件，适合成组重整命名。',
    compatibility: 'incompatible',
    compatibilityNote: '这是高风险批量写操作，agent 链路不应暴露。',
    hardDependencies: [],
    relatedTools: ['file_rename', 'file_list', 'file_glob'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'file_multi_write',
    title: '批量写入',
    category: 'file',
    description: '一次写入多个文件，适合生成成组文件或模板批量落盘。',
    compatibility: 'incompatible',
    compatibilityNote: '这是最危险的写操作之一，agent 里不应开启。',
    hardDependencies: [],
    relatedTools: ['file_write', 'file_update'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'file_update',
    title: '文件更新',
    category: 'file',
    description: '按文本替换更新文件内容，适合小范围修补。',
    compatibility: 'incompatible',
    compatibilityNote: '这是文件写回能力，适合后台代理，不适合agent。',
    hardDependencies: [],
    relatedTools: ['file_read', 'file_write', 'file_multi_write'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'web_search',
    title: '联网搜索',
    category: 'web',
    description: '搜索互联网信息，用于事实查询、新闻和陌生名词确认。',
    compatibility: 'conditional',
    compatibilityNote: '可以作为后台检索能力，但适合作为 agent 的后台检索能力，agent 默认不应开放。',
    hardDependencies: [],
    relatedTools: ['web_browser', 'web_fetch'],
    riskLevel: 'medium',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'web_browser',
    title: '网页浏览',
    category: 'web',
    description: '打开并分析网页内容，适合需要看页面结构或交互结果的任务。',
    compatibility: 'incompatible',
    compatibilityNote: '会把模型拉进浏览器代理工作流，通常不适合agent 对话。',
    hardDependencies: [],
    relatedTools: ['web_search', 'web_fetch', 'web_post'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'web_fetch',
    title: '网页抓取',
    category: 'web',
    description: '直接抓取指定 URL 的文本内容，适合快速拿网页正文。',
    compatibility: 'incompatible',
    compatibilityNote: '这是网页代理工具链的一部分，通常不应在agent 里直接开放。',
    hardDependencies: [],
    relatedTools: ['web_search', 'web_browser', 'web_post'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'web_post',
    title: 'HTTP POST',
    category: 'web',
    description: '向指定 URL 发送 JSON POST 请求，适合对接后台接口。',
    compatibility: 'incompatible',
    compatibilityNote: '这是带副作用的网络写操作工具，适合后台代理，不适合普通聊天。',
    hardDependencies: [],
    relatedTools: ['web_fetch', 'web_browser'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'a9pt1r',
    title: '城市经纬度',
    category: 'geo',
    description: '根据城市名称查询经纬度，通常作为天气查询的前置步骤。',
    compatibility: 'conditional',
    compatibilityNote: '可以作为后台地理能力使用，单独开启时要确保后续天气流程仍然可用。',
    hardDependencies: [],
    relatedTools: ['z9uylx'],
    riskLevel: 'medium',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'z9uylx',
    title: '未来天气',
    category: 'geo',
    description: '根据经纬度查询未来天气预报，适合天气类问答。',
    compatibility: 'conditional',
    compatibilityNote: '通常建议配合城市经纬度查询一起使用，避免只能处理坐标输入的场景。',
    hardDependencies: ['a9pt1r'],
    relatedTools: ['a9pt1r'],
    riskLevel: 'medium',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
]

export function buildToolScopeKey(scope: Pick<ToolPolicyScope, 'scopeKind' | 'scopeId'>): string {
  return `${scope.scopeKind}:${scope.scopeId}`
}

export function buildToolOverrideKey(
  scopeKind: ToolPolicyScopeKind,
  scopeId: string,
  routeProfile: ToolRouteProfile,
  toolName: string,
): string {
  return `${routeProfile}:${scopeKind}:${scopeId}:${toolName}`
}

export function normalizeToolOverrideMode(
  enabled: number | boolean | null | undefined,
): ToolOverrideMode {
  if (enabled == null) return 'inherit'
  return Number(enabled) === 1 || enabled === true ? 'enabled' : 'disabled'
}

export function denormalizeToolOverrideMode(mode: ToolOverrideMode): boolean | null {
  if (mode === 'inherit') return null
  return mode === 'enabled'
}

export function getToolCategoryLabel(category: ToolCategoryKey): string {
  return TOOL_CATEGORY_LABELS[category] ?? category
}

export function getToolRouteLabel(routeProfile: ToolRouteProfile): string {
  return TOOL_ROUTE_LABELS[routeProfile] ?? routeProfile
}

export function getToolCompatibilityLabel(compatibility: ToolCompatibility): string {
  return TOOL_COMPATIBILITY_LABELS[compatibility] ?? compatibility
}

export function getToolRiskLabel(riskLevel: ToolRiskLevel): string {
  return TOOL_RISK_LABELS[riskLevel] ?? riskLevel
}

export function getToolCompatibilityTone(compatibility: ToolCompatibility): 'success' | 'warning' | 'danger' {
  if (compatibility === 'compatible') return 'success'
  if (compatibility === 'conditional') return 'warning'
  return 'danger'
}

export function getToolScopeLabel(scope: ToolPolicyScope): string {
  if (scope.scopeKind === 'global_default') return '全局默认'
  if (scope.scopeKind === 'private_default') return '私聊默认'
  if (scope.scopeKind === 'group') return scope.roomName || `群聊 ${scope.scopeId}`
  return scope.roomName || `私聊 ${scope.roomId ?? scope.scopeId}`
}

export function getToolScopeMeta(scope: ToolPolicyScope): string {
  if (scope.scopeKind === 'global_default') return '影响所有会话，作为最终兜底。'
  if (scope.scopeKind === 'private_default') return '影响所有新私聊，会被单个私聊覆盖。'
  if (scope.scopeKind === 'group') return `群号 ${scope.scopeId}${scope.roomId ? ` · 房间 #${scope.roomId}` : ''}`
  return `私聊房间 #${scope.roomId ?? scope.scopeId}`
}
