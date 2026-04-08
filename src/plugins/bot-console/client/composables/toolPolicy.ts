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
    toolName: 'skill',
    title: '技能激活',
    category: 'builtin',
    description: '按名称加载已注入的 ChatLuna skill 指令集。',
    compatibility: 'conditional',
    compatibilityNote: '这是 Agent 自身的技能装载入口，默认关闭，只有明确需要时才建议放行。',
    hardDependencies: [],
    relatedTools: ['agentcli'],
    riskLevel: 'medium',
    availableRoutes: ['agent'],
    defaultEnabledByRoute: { agent: false, automation: false },
  },
  {
    toolName: 'agentcli',
    title: 'Agent 配置命令',
    category: 'builtin',
    description: '执行 ChatLuna agentcli 管理命令，读取或修改 Agent 的技能、子代理与工具配置。',
    compatibility: 'incompatible',
    compatibilityNote: '这是高风险的 Agent 内部管理入口，默认关闭，不应在普通 qqbot 回复链路中暴露。',
    hardDependencies: [],
    relatedTools: ['skill'],
    riskLevel: 'high',
    availableRoutes: ['agent'],
    defaultEnabledByRoute: { agent: false, automation: false },
  },
  {
    toolName: 'file_read',
    title: '文件读取',
    category: 'file',
    description: '从磁盘读取文件内容，用于查看配置、源码或运行产物。',
    compatibility: 'incompatible',
    compatibilityNote: '宿主机文件读取能力，启用后模型可直接读取本机文件。',
    hardDependencies: [],
    relatedTools: ['file_write', 'file_edit', 'grep', 'glob', 'bash'],
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
    compatibilityNote: '宿主机文件写入能力，启用后模型可直接修改本机文件。',
    hardDependencies: [],
    relatedTools: ['file_read', 'file_edit', 'file_publish', 'bash'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'file_edit',
    title: '文件编辑',
    category: 'file',
    description: '按匹配片段更新现有文件内容，适合小范围定向修改。',
    compatibility: 'incompatible',
    compatibilityNote: '宿主机文件编辑能力，启用后模型可直接修改本机文件片段。',
    hardDependencies: [],
    relatedTools: ['file_read', 'file_write', 'file_publish', 'bash'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'file_publish',
    title: '文件发布',
    category: 'file',
    description: '发布本地文件并生成可访问的文件链接或产物引用。',
    compatibility: 'incompatible',
    compatibilityNote: '宿主机文件发布能力，启用后模型可将本地文件暴露为外部可访问产物。',
    hardDependencies: [],
    relatedTools: ['file_read', 'file_write', 'file_edit'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'grep',
    title: '文件检索',
    category: 'file',
    description: '按正则在文件中搜索内容，适合定位关键词、错误和配置项。',
    compatibility: 'incompatible',
    compatibilityNote: '宿主机文件检索能力，启用后模型可直接扫描本机文件内容。',
    hardDependencies: [],
    relatedTools: ['file_read', 'glob', 'bash'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'glob',
    title: '文件模式匹配',
    category: 'file',
    description: '用 glob 语法查找文件，适合批量定位同类文件。',
    compatibility: 'incompatible',
    compatibilityNote: '宿主机文件发现能力，启用后模型可遍历并匹配本机路径。',
    hardDependencies: [],
    relatedTools: ['file_read', 'grep', 'bash'],
    riskLevel: 'high',
    availableRoutes: ['agent', 'automation'],
    defaultEnabledByRoute: { agent: true, automation: true },
  },
  {
    toolName: 'bash',
    title: 'Bash 执行',
    category: 'file',
    description: '在宿主机本地 shell 中执行命令并返回标准输出/错误。',
    compatibility: 'incompatible',
    compatibilityNote: '这是宿主机高权限命令执行能力，当前配置下可联网且不需要审批。',
    hardDependencies: [],
    relatedTools: ['file_read', 'file_write', 'file_edit', 'grep', 'glob'],
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
