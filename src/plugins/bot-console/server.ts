import { constants as fsConstants, existsSync } from 'node:fs';
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import type {
  BotConsoleEnvFilesState,
  BotConsoleBuiltinModelTab,
  BotConsoleAuthStatus,
  BotConsoleModelTabId,
  BotConsoleModelTabsState,
  BotServiceStatus,
  BotServiceUnit,
  EnvPatch,
  PresetDocument,
  PresetSource,
  PresetSummary,
  SaveModelTabsRequest,
  ServiceAction,
} from '../../types/bot-console.js';
import {
  buildMainChatRuntimeEnvPatch,
  getBuiltinMainChatTabDefinition,
  getMainChatProviderStrategy,
  isSupportedMainChatModelForTab,
  MAIN_CHAT_BUILTIN_TAB_IDS,
  normalizeMainChatBuiltinTabId,
  resolveMainChatActiveTabFromEnv,
  resolveMainChatTabStateFromEnv,
} from '../shared/llm/index.js';

const execFile = promisify(execFileCallback);

type ManagedEnvField = {
  key: string;
  label: string;
  type: 'toggle' | 'text' | 'secret' | 'number';
  section: 'features' | 'model' | 'basic';
};

type ExecResult = {
  stdout: string;
  stderr: string;
};

type FsLike = {
  access: typeof access;
  copyFile: typeof copyFile;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  readdir: typeof readdir;
  rename: typeof rename;
  rm: typeof rm;
  stat: typeof stat;
  writeFile: typeof writeFile;
};

type BotConsoleManagerOptions = {
  rootDir?: string;
  envFilePath?: string;
  envBaseFilePath?: string;
  envOverrideFilePath?: string;
  presetDirPath?: string;
  runtimePresetDirPath?: string;
  bundledPresetDirPaths?: string[];
  fs?: FsLike;
  execFile?: (file: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;
  copilotBridge?: CopilotBridgeStateProvider;
};

type EnvLine =
  | { type: 'kv'; key: string; rawValue: string }
  | { type: 'other'; value: string };

type BotConsoleStaticState = {
  env: Record<string, string>;
  envFiles: BotConsoleEnvFilesState;
  services: BotServiceStatus[];
  presets: PresetSummary[];
  defaultPreset: string;
  modelTabs: BotConsoleModelTabsState;
};

type CopilotBridgeRuntimeConfig = {
  baseUrl: string;
  apiKey: string;
};

type CopilotBridgeConsoleState = {
  authKind: 'oauth_device';
  authStatus: BotConsoleAuthStatus;
  accountLabel: string | null;
  authError: string | null;
};

type CopilotBridgeStateProvider = {
  getRuntimeConfig: () => Promise<CopilotBridgeRuntimeConfig>;
  getConsoleStatus: (options?: { probe?: boolean }) => Promise<CopilotBridgeConsoleState>;
};

type ResolvedEnvFiles = {
  mode: 'single' | 'layered';
  baseFilePath: string | null;
  overrideFilePath: string | null;
  editTarget: string;
};

type ResolvedPresetPaths = {
  mode: 'single' | 'layered';
  runtimeDirPath: string;
  bundledDirPaths: string[];
  allDirPaths: string[];
};

type PresetOrderDocument = {
  names?: unknown;
};

const DEFAULT_ROOT_DIR = resolve(process.cwd());
const LOCAL_ENV_FILE_BASENAME = '.env.local';
const SERVER_ENV_FILE_BASENAME = '.env.server';
const PRESET_DIR_RELATIVE = 'data/chathub/presets';
const PRESET_ORDER_FILENAME = '.bot-console-preset-order.json';
const PRESET_ROLE_SET = new Set(['system', 'user', 'assistant', 'tool']);
const RUNTIME_ENV_FILE_BASENAME = '.env.runtime';
const LOCAL_RUNTIME_ENV_RELATIVE = join('.runtime', RUNTIME_ENV_FILE_BASENAME);

export const BOT_CONSOLE_ENV_FIELDS: ManagedEnvField[] = [
  { key: 'QQ_VOICE_INPUT_ENABLED', label: '语音转文字', type: 'toggle', section: 'features' },
  { key: 'QQ_VOICE_OUTPUT_ENABLED', label: '语音回复', type: 'toggle', section: 'features' },
  { key: 'CHAT_NATURAL_TRIGGER_ENABLED', label: '群聊自然触发', type: 'toggle', section: 'features' },
  { key: 'CHAT_NATURAL_TRIGGER_GROUPS', label: '自然触发白名单群', type: 'text', section: 'features' },
  { key: 'QQBOT_REPLY_INTERRUPT_ENABLED', label: '回复期中断', type: 'toggle', section: 'features' },
  { key: 'CHATLUNA_COMMON_FS', label: '文件系统工具总开关', type: 'toggle', section: 'features' },
  { key: 'CHATLUNA_COMMON_FS_SCOPE_PATH', label: '文件系统作用域目录', type: 'text', section: 'features' },
  { key: 'CHATLUNA_ACTIVE_TAB', label: '当前对话模型 Tab', type: 'text', section: 'model' },
  { key: 'CHATLUNA_PLATFORM', label: '当前对话模型平台', type: 'text', section: 'model' },
  { key: 'CHATLUNA_BASE_URL', label: '对话模型接口地址', type: 'text', section: 'model' },
  { key: 'CHATLUNA_API_KEY', label: '对话模型接口密钥', type: 'secret', section: 'model' },
  { key: 'CHATLUNA_DEFAULT_MODEL', label: '对话默认模型', type: 'text', section: 'model' },
  { key: 'CHATLUNA_MAX_CONTEXT_RATIO', label: '上下文窗口使用比例', type: 'number', section: 'model' },
  { key: 'CHATLUNA_SILICONFLOW_BASE_URL', label: '硅基流动接口地址', type: 'text', section: 'model' },
  { key: 'CHATLUNA_SILICONFLOW_API_KEY', label: '硅基流动接口密钥', type: 'secret', section: 'model' },
  { key: 'CHATLUNA_SILICONFLOW_DEFAULT_MODEL', label: '硅基流动默认模型', type: 'text', section: 'model' },
  { key: 'CHATLUNA_OPENAI_BASE_URL', label: 'OpenAI 接口地址', type: 'text', section: 'model' },
  { key: 'CHATLUNA_OPENAI_API_KEY', label: 'OpenAI 接口密钥', type: 'secret', section: 'model' },
  { key: 'CHATLUNA_OPENAI_DEFAULT_MODEL', label: 'OpenAI 默认模型', type: 'text', section: 'model' },
  { key: 'CHATLUNA_COPILOT_BASE_URL', label: 'GitHub Copilot 接口地址', type: 'text', section: 'model' },
  { key: 'CHATLUNA_COPILOT_API_KEY', label: 'GitHub Copilot Bridge 密钥', type: 'secret', section: 'model' },
  { key: 'CHATLUNA_COPILOT_DEFAULT_MODEL', label: 'GitHub Copilot 默认模型', type: 'text', section: 'model' },
  { key: 'OPENAI_BASE_URL', label: '通用模型接口地址', type: 'text', section: 'model' },
  { key: 'OPENAI_API_KEY', label: '通用模型接口密钥', type: 'secret', section: 'model' },
  { key: 'OPENAI_MODEL', label: '通用默认模型', type: 'text', section: 'model' },
  { key: 'CHATLUNA_DEFAULT_PRESET', label: '默认预设', type: 'text', section: 'model' },
  { key: 'CHAT_NATURAL_TRIGGER_ALIASES', label: '触发别名', type: 'text', section: 'basic' },
  { key: 'CHATLUNA_COMMAND_AUTHORITY', label: '命令权限等级', type: 'number', section: 'basic' },
];

export const BOT_CONSOLE_ENV_KEYS = new Set(BOT_CONSOLE_ENV_FIELDS.map((field) => field.key));
export const BOT_CONSOLE_SERVICE_UNITS: readonly BotServiceUnit[] = [
  'qqbot.target',
  'qqbot-koishi.service',
  'qqbot-stack.service',
  'qqbot-voice-tts.service',
  'qqbot-voice-tts-tailnet.service',
] as const;

const ASYNC_RESTART_UNITS = new Set<BotServiceUnit>([
  'qqbot.target',
  'qqbot-koishi.service',
]);

function defaultFs(): FsLike {
  return {
    access,
    copyFile,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
  };
}

function defaultExec(file: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<ExecResult> {
  return execFile(file, args, options) as Promise<ExecResult>;
}

function ensureManagedKey(key: string): void {
  if (!BOT_CONSOLE_ENV_KEYS.has(key)) {
    throw new Error(`不支持这个配置项：${key}`);
  }
}

export function buildModelTabsStateFromEnv(env: Record<string, string>): BotConsoleModelTabsState {
  const activeTab = resolveMainChatActiveTabFromEnv(env) as BotConsoleModelTabId;
  const tabs = MAIN_CHAT_BUILTIN_TAB_IDS.map((id) => resolveMainChatTabStateFromEnv(id, env) as BotConsoleBuiltinModelTab);

  return {
    activeTab,
    tabs,
  };
}

function findRequiredModelTab(
  tabs: readonly BotConsoleBuiltinModelTab[],
  id: BotConsoleModelTabId,
): BotConsoleBuiltinModelTab {
  const tab = tabs.find((item) => item.id === id);
  if (!tab) {
    throw new Error(`缺少内置模型 Tab：${id}`);
  }
  return tab;
}

function normalizeModelTabInput(
  input: Partial<BotConsoleBuiltinModelTab> | null | undefined,
): BotConsoleBuiltinModelTab {
  const id = normalizeMainChatBuiltinTabId(input?.id) as BotConsoleModelTabId;
  const defaultTab = resolveMainChatTabStateFromEnv(id, readManagedEnvFromContent('')) as BotConsoleBuiltinModelTab;
  const definition = getBuiltinMainChatTabDefinition(id);
  const strategy = getMainChatProviderStrategy(definition.strategyId);
  const normalizedModel = strategy.normalizeModel(String(input?.defaultModel ?? defaultTab.defaultModel ?? '').trim()) ?? '';
  const normalized: BotConsoleBuiltinModelTab = {
    id,
    title: definition.title,
    provider: definition.provider,
    strategyId: defaultTab.strategyId,
    requestMode: defaultTab.requestMode,
    structuredOutputProtocol: defaultTab.structuredOutputProtocol,
    description: defaultTab.description,
    modelHint: defaultTab.modelHint,
    authKind: defaultTab.authKind,
    authStatus: defaultTab.authStatus,
    accountLabel: defaultTab.accountLabel,
    authError: defaultTab.authError,
    baseUrl: String(input?.baseUrl ?? defaultTab.baseUrl ?? '').trim(),
    apiKey: String(input?.apiKey ?? defaultTab.apiKey ?? '').trim(),
    defaultModel: normalizedModel,
  };

  if (!isSupportedMainChatModelForTab(id, normalized.defaultModel)) {
    throw new Error(`${normalized.title} Tab 只支持当前允许的模型族，收到：${normalized.defaultModel || '空值'}`);
  }

  return normalized;
}

export function parseEnvLines(content: string): EnvLine[] {
  return content.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return { type: 'other', value: line };
    return { type: 'kv', key: match[1], rawValue: match[2] };
  });
}

export function parseEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return trimmed;
}

export function readManagedEnvFromContent(content: string): Record<string, string> {
  return mergeManagedEnvRecords(readManagedEnvPatchFromContent(content));
}

export function readManagedEnvPatchFromContent(content: string): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {};
  for (const line of parseEnvLines(content)) {
    if (line.type !== 'kv' || !BOT_CONSOLE_ENV_KEYS.has(line.key)) continue;
    result[line.key] = parseEnvValue(line.rawValue);
  }
  return result;
}

export function mergeManagedEnvRecords(...records: Array<Partial<Record<string, string>>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of BOT_CONSOLE_ENV_KEYS) {
    result[key] = '';
  }

  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (!BOT_CONSOLE_ENV_KEYS.has(key)) continue;
      result[key] = value ?? '';
    }
  }
  return result;
}

export function formatEnvValue(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./,:@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function applyEnvPatchToContent(content: string, patch: EnvPatch): string {
  for (const key of Object.keys(patch)) {
    ensureManagedKey(key);
  }

  const lines = parseEnvLines(content);
  const pending = new Map<string, string | null>();
  for (const [key, value] of Object.entries(patch)) {
    pending.set(key, value == null ? null : String(value));
  }

  const output: string[] = [];
  for (const line of lines) {
    if (line.type !== 'kv' || !pending.has(line.key)) {
      output.push(line.type === 'kv' ? `${line.key}=${line.rawValue}` : line.value);
      continue;
    }

    const nextValue = pending.get(line.key);
    pending.delete(line.key);
    if (nextValue == null) continue;
    output.push(`${line.key}=${formatEnvValue(nextValue)}`);
  }

  if (output.length && output[output.length - 1] !== '') {
    output.push('');
  }

  for (const [key, value] of pending.entries()) {
    if (value == null) continue;
    output.push(`${key}=${formatEnvValue(value)}`);
  }

  return `${output.join('\n').replace(/\n+$/g, '')}\n`;
}

export function resolveBotEnvFilePath(rootDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.QQBOT_ENV_FILE?.trim();
  if (explicit) {
    return explicit.startsWith('/') ? explicit : resolve(rootDir, explicit);
  }

  const localEnvPath = join(rootDir, LOCAL_ENV_FILE_BASENAME);
  if (existsSync(localEnvPath)) {
    return localEnvPath;
  }

  const serverEnvPath = join(rootDir, SERVER_ENV_FILE_BASENAME);
  if (existsSync(serverEnvPath)) {
    return serverEnvPath;
  }

  return localEnvPath;
}

function resolvePathLike(rootDir: string, filePath: string): string {
  return filePath.startsWith('/') ? filePath : resolve(rootDir, filePath);
}

export function resolveBotEnvFiles(rootDir: string, env: NodeJS.ProcessEnv = process.env): ResolvedEnvFiles {
  const explicitBase = env.QQBOT_ENV_BASE_FILE?.trim();
  const explicitOverride = env.QQBOT_ENV_OVERRIDE_FILE?.trim();
  if (!explicitBase && !explicitOverride) {
    const envFilePath = resolveBotEnvFilePath(rootDir, env);
    if (envFilePath.endsWith(`/${LOCAL_ENV_FILE_BASENAME}`) || envFilePath.endsWith(`\\${LOCAL_ENV_FILE_BASENAME}`)) {
      const overrideFilePath = join(rootDir, LOCAL_RUNTIME_ENV_RELATIVE);
      return {
        mode: 'layered',
        baseFilePath: envFilePath,
        overrideFilePath,
        editTarget: overrideFilePath,
      };
    }
    return {
      mode: 'single',
      baseFilePath: envFilePath,
      overrideFilePath: null,
      editTarget: envFilePath,
    };
  }

  return {
    mode: 'layered',
    baseFilePath: resolvePathLike(rootDir, explicitBase || join(rootDir, SERVER_ENV_FILE_BASENAME)),
    overrideFilePath: resolvePathLike(rootDir, explicitOverride || join(rootDir, RUNTIME_ENV_FILE_BASENAME)),
    editTarget: resolvePathLike(rootDir, explicitOverride || join(rootDir, RUNTIME_ENV_FILE_BASENAME)),
  };
}

function splitPresetDirs(rawValue: string | undefined, rootDir: string): string[] {
  return [...new Set(
    String(rawValue ?? '')
      .split(delimiter)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => resolvePathLike(rootDir, part)),
  )];
}

export function resolveBotPresetPaths(rootDir: string, env: NodeJS.ProcessEnv = process.env): ResolvedPresetPaths {
  const runtimeDir = env.CHATLUNA_RUNTIME_PRESET_DIR?.trim();
  const configuredDirs = splitPresetDirs(env.CHATLUNA_PRESET_DIRS, rootDir);
  if (!runtimeDir && configuredDirs.length === 0) {
    const singleDirPath = join(rootDir, PRESET_DIR_RELATIVE);
    return {
      mode: 'single',
      runtimeDirPath: singleDirPath,
      bundledDirPaths: [],
      allDirPaths: [singleDirPath],
    };
  }

  const runtimeDirPath = resolvePathLike(rootDir, runtimeDir || configuredDirs[0] || join(rootDir, PRESET_DIR_RELATIVE));
  const allDirPaths = [...new Set([runtimeDirPath, ...configuredDirs])];

  return {
    mode: 'layered',
    runtimeDirPath,
    bundledDirPaths: allDirPaths.filter((dirPath) => dirPath !== runtimeDirPath),
    allDirPaths,
  };
}

async function readFileIfExists(fsLike: FsLike, filePath: string | null): Promise<string> {
  if (!filePath) return '';
  try {
    return await fsLike.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

export async function writeFileAtomicWithBackup(
  filePath: string,
  content: string,
  fsLike: FsLike = defaultFs(),
  timestamp = new Date(),
): Promise<{ backupPath: string; tempPath: string }> {
  const stamp = timestamp.toISOString().replace(/[:.]/g, '-');
  const backupPath = `${filePath}.bak.${stamp}`;
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;

  await fsLike.mkdir(dirname(filePath), { recursive: true });
  try {
    await fsLike.copyFile(filePath, backupPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await fsLike.writeFile(tempPath, content, 'utf8');
    await fsLike.rename(tempPath, filePath);
  } catch (error) {
    await fsLike.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }

  return { backupPath, tempPath };
}

export function parseSystemdShowOutput(text: string, unit: BotServiceUnit): BotServiceStatus {
  const values = Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=');
        if (index < 0) return [line, ''];
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );

  const activeState = values.ActiveState || 'unknown';
  const unitFileState = values.UnitFileState || 'unknown';
  return {
    unit,
    description: values.Description || unit,
    loadState: values.LoadState || 'unknown',
    activeState,
    subState: values.SubState || 'unknown',
    unitFileState,
    canStart: activeState !== 'active',
    canStop: activeState === 'active',
    canRestart: activeState === 'active',
    canEnable: !['enabled', 'static'].includes(unitFileState),
  };
}

export function validateServiceAction(unit: string, action: string): asserts unit is BotServiceUnit & string {
  if (!BOT_CONSOLE_SERVICE_UNITS.includes(unit as BotServiceUnit)) {
    throw new Error(`不支持这个服务：${unit}`);
  }
  if (!['start', 'stop', 'restart', 'enable'].includes(action)) {
    throw new Error(`不支持这个操作：${action}`);
  }
}

export function normalizePresetDocument(input: PresetDocument): PresetDocument {
  const name = input.name.trim();
  if (!name) throw new Error('预设名不能为空。');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('预设名只能包含字母、数字、点号、下划线或短横线。');
  }

  const keywords = (input.keywords ?? []).map((item) => item.trim()).filter(Boolean);
  const prompts = (input.prompts ?? []).map((prompt) => ({
    role: prompt.role,
    content: prompt.content.trim(),
  }));

  if (!prompts.length) {
    throw new Error('至少需要保留一段提示词。');
  }

  for (const prompt of prompts) {
    if (!PRESET_ROLE_SET.has(prompt.role)) {
      throw new Error(`不支持这个角色类型：${prompt.role}`);
    }
    if (!prompt.content) {
      throw new Error('提示词内容不能为空。');
    }
  }

  return {
    name,
    originalName: input.originalName?.trim() || undefined,
    path: input.path,
    source: input.source ?? 'runtime',
    keywords,
    prompts,
  };
}

export function serializePresetDocument(input: PresetDocument): string {
  const document = normalizePresetDocument(input);
  return YAML.stringify({
    keywords: document.keywords,
    prompts: document.prompts,
  });
}

export function parsePresetDocument(name: string, path: string, raw: string, source: PresetSource = 'runtime'): PresetDocument {
  const parsed = YAML.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('预设文件格式不正确。');
  }
  const keywords = Array.isArray((parsed as { keywords?: unknown }).keywords)
    ? (parsed as { keywords: unknown[] }).keywords.map((item) => String(item))
    : [];
  const prompts = Array.isArray((parsed as { prompts?: unknown }).prompts)
    ? (parsed as { prompts: Array<{ role?: unknown; content?: unknown }> }).prompts.map((item) => ({
        role: String(item?.role ?? '') as PresetDocument['prompts'][number]['role'],
        content: String(item?.content ?? ''),
      }))
    : [];

  return normalizePresetDocument({
    name,
    path,
    source,
    raw,
    keywords,
    prompts,
  });
}

export class BotConsoleManager {
  readonly rootDir: string;
  readonly envFiles: ResolvedEnvFiles;
  readonly runtimePresetDirPath: string;
  readonly bundledPresetDirPaths: string[];
  readonly allPresetDirPaths: string[];
  readonly fs: FsLike;
  readonly execFile: (file: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;
  readonly copilotBridge?: CopilotBridgeStateProvider;

  constructor(options: BotConsoleManagerOptions = {}) {
    this.rootDir = options.rootDir ? resolve(options.rootDir) : DEFAULT_ROOT_DIR;
    this.envFiles =
      options.envBaseFilePath || options.envOverrideFilePath
        ? {
            mode: 'layered',
            baseFilePath: options.envBaseFilePath ? resolve(this.rootDir, options.envBaseFilePath) : join(this.rootDir, SERVER_ENV_FILE_BASENAME),
            overrideFilePath: options.envOverrideFilePath
              ? resolve(this.rootDir, options.envOverrideFilePath)
              : join(this.rootDir, RUNTIME_ENV_FILE_BASENAME),
            editTarget: options.envOverrideFilePath
              ? resolve(this.rootDir, options.envOverrideFilePath)
              : join(this.rootDir, RUNTIME_ENV_FILE_BASENAME),
          }
        : options.envFilePath
          ? {
              mode: 'single',
              baseFilePath: resolve(this.rootDir, options.envFilePath),
              overrideFilePath: null,
              editTarget: resolve(this.rootDir, options.envFilePath),
            }
          : resolveBotEnvFiles(this.rootDir);
    if (options.runtimePresetDirPath || options.bundledPresetDirPaths) {
      this.runtimePresetDirPath = options.runtimePresetDirPath
        ? resolve(this.rootDir, options.runtimePresetDirPath)
        : options.presetDirPath
          ? resolve(this.rootDir, options.presetDirPath)
          : join(this.rootDir, PRESET_DIR_RELATIVE);
      this.bundledPresetDirPaths = (options.bundledPresetDirPaths ?? []).map((dirPath) => resolve(this.rootDir, dirPath));
      this.allPresetDirPaths = [...new Set([this.runtimePresetDirPath, ...this.bundledPresetDirPaths])];
    } else if (options.presetDirPath) {
      this.runtimePresetDirPath = resolve(this.rootDir, options.presetDirPath);
      this.bundledPresetDirPaths = [];
      this.allPresetDirPaths = [this.runtimePresetDirPath];
    } else {
      const presetPaths = resolveBotPresetPaths(this.rootDir);
      this.runtimePresetDirPath = presetPaths.runtimeDirPath;
      this.bundledPresetDirPaths = presetPaths.bundledDirPaths;
      this.allPresetDirPaths = presetPaths.allDirPaths;
    }
    this.fs = options.fs ?? defaultFs();
    this.execFile = options.execFile ?? defaultExec;
    this.copilotBridge = options.copilotBridge;
  }

  async getState(): Promise<BotConsoleStaticState> {
    const [baseEnvContent, overrideEnvContent, presets, services] = await Promise.all([
      readFileIfExists(this.fs, this.envFiles.baseFilePath),
      readFileIfExists(this.fs, this.envFiles.overrideFilePath),
      this.listPresetSummaries(),
      this.getServiceStatuses(),
    ]);

    const env = mergeManagedEnvRecords(
      readManagedEnvPatchFromContent(baseEnvContent),
      readManagedEnvPatchFromContent(overrideEnvContent),
    );
    const modelTabs = await this.decorateModelTabsState(buildModelTabsStateFromEnv(env));
    return {
      env,
      envFiles: {
        mode: this.envFiles.mode,
        baseFile: this.envFiles.baseFilePath,
        overrideFile: this.envFiles.overrideFilePath,
        editTarget: this.envFiles.editTarget,
      },
      services,
      presets,
      defaultPreset: env.CHATLUNA_DEFAULT_PRESET || 'sakiko',
      modelTabs,
    };
  }

  async getPreset(name: string): Promise<PresetDocument> {
    const normalized = normalizePresetDocument({ name, keywords: [], prompts: [{ role: 'system', content: 'x' }] }).name;
    const summary = await this.findPresetSummaryByName(normalized);
    if (!summary) {
      throw new Error(`找不到预设：${normalized}`);
    }
    const raw = await this.fs.readFile(summary.path, 'utf8');
    return parsePresetDocument(normalized, summary.path, raw, summary.source);
  }

  async saveEnv(patch: EnvPatch): Promise<Record<string, string>> {
    const [baseContent, currentTargetContent] = await Promise.all([
      readFileIfExists(this.fs, this.envFiles.baseFilePath),
      readFileIfExists(this.fs, this.envFiles.editTarget),
    ]);
    const nextTargetContent = applyEnvPatchToContent(currentTargetContent, patch);
    await writeFileAtomicWithBackup(this.envFiles.editTarget, nextTargetContent, this.fs);
    return mergeManagedEnvRecords(
      readManagedEnvPatchFromContent(baseContent),
      readManagedEnvPatchFromContent(nextTargetContent),
    );
  }

  async saveModelTabs(input: SaveModelTabsRequest): Promise<{ env: Record<string, string>; modelTabs: BotConsoleModelTabsState }> {
    const env = await this.saveEnv(await this.buildModelTabsPatch(input));
    return {
      env,
      modelTabs: await this.decorateModelTabsState(buildModelTabsStateFromEnv(env)),
    };
  }

  async savePreset(document: PresetDocument): Promise<PresetDocument> {
    const normalized = normalizePresetDocument(document);
    const targetPath = this.resolveRuntimePresetPath(normalized.name);
    const sourceName = normalized.originalName?.trim() || normalized.name;
    const sourceSummary = sourceName ? await this.findPresetSummaryByName(sourceName) : null;

    if (sourceName !== normalized.name && !sourceSummary) {
      throw new Error(`找不到预设：${sourceName}`);
    }

    const raw = serializePresetDocument(normalized);
    await this.fs.mkdir(this.runtimePresetDirPath, { recursive: true });
    await this.fs.writeFile(targetPath, raw, 'utf8');

    if (sourceName !== normalized.name && normalized.source === 'runtime' && sourceSummary?.source === 'runtime') {
      const sourcePath = this.resolveRuntimePresetPath(sourceName);
      await this.fs.rm(sourcePath, { force: true });
    }

    await this.updatePresetOrder((names) => {
      if (sourceName !== normalized.name) {
        if (normalized.source === 'runtime') {
          const sourceIndex = names.indexOf(sourceName);
          if (sourceIndex >= 0) {
            names.splice(sourceIndex, 1, normalized.name);
          } else if (!names.includes(normalized.name)) {
            names.push(normalized.name);
          }
          return names;
        }

        if (!names.includes(normalized.name)) {
          names.push(normalized.name);
        }
        return names;
      }

      if (!names.includes(normalized.name)) {
        names.push(normalized.name);
      }
      return names;
    });

    return {
      ...normalized,
      path: targetPath,
      source: 'runtime',
      raw,
    };
  }

  async deletePreset(name: string, defaultPreset: string): Promise<void> {
    const normalized = normalizePresetDocument({ name, keywords: [], prompts: [{ role: 'system', content: 'x' }] }).name;
    if (normalized === defaultPreset) {
      throw new Error('不能删除当前正在使用的默认预设。');
    }
    const preset = await this.findPresetSummaryByName(normalized);
    if (!preset) {
      throw new Error(`找不到预设：${normalized}`);
    }
    if (preset.source !== 'runtime') {
      throw new Error('只能删除运行时预设；仓库内置预设请通过代码仓库修改。');
    }
    await this.fs.rm(this.resolveRuntimePresetPath(normalized), { force: true });
    const bundledFallback = await this.findBundledPresetSummaryByName(normalized);
    await this.updatePresetOrder((names) => (bundledFallback ? names : names.filter((item) => item !== normalized)));
  }

  async reorderPresets(names: string[]): Promise<PresetSummary[]> {
    const normalizedNames = names.map((name) =>
      normalizePresetDocument({ name, keywords: [], prompts: [{ role: 'system', content: 'x' }] }).name,
    );
    const uniqueNames = [...new Set(normalizedNames)];
    const presets = await this.readPresetSummariesFromDisk();
    const presetNames = presets.map((preset) => preset.name);

    if (uniqueNames.length !== presetNames.length) {
      throw new Error('预设排序数据不完整。');
    }

    const presetNameSet = new Set(presetNames);
    if (uniqueNames.some((name) => !presetNameSet.has(name))) {
      throw new Error('预设排序包含不存在的预设。');
    }

    await this.writePresetOrder(uniqueNames);
    return this.sortPresetSummaries(presets, uniqueNames);
  }

  async scheduleRestart(unit: BotServiceUnit): Promise<void> {
    const transientUnit = `${unit.replaceAll(/[^A-Za-z0-9]+/g, '-')}-restart-${Date.now()}`;
    await this.execFile(
      'systemd-run',
      [
        '--user',
        '--quiet',
        '--on-active=1s',
        `--unit=${transientUnit}`,
        'systemctl',
        '--user',
        'restart',
        unit,
      ],
      { cwd: this.rootDir, timeout: 15_000 },
    );
  }

  async runServiceAction(unit: BotServiceUnit, action: ServiceAction): Promise<BotServiceStatus> {
    validateServiceAction(unit, action);
    if (action === 'restart' && ASYNC_RESTART_UNITS.has(unit)) {
      // Hand restarts that can terminate the current request off to a transient
      // user unit so the console response can return before systemd stops Koishi.
      await this.scheduleRestart(unit);
      return this.getServiceStatus(unit);
    }
    await this.execFile('systemctl', ['--user', action, unit], { cwd: this.rootDir, timeout: 15_000 });
    return this.getServiceStatus(unit);
  }

  async getServiceStatuses(): Promise<BotServiceStatus[]> {
    return Promise.all(BOT_CONSOLE_SERVICE_UNITS.map((unit) => this.getServiceStatus(unit)));
  }

  async getServiceStatus(unit: BotServiceUnit): Promise<BotServiceStatus> {
    validateServiceAction(unit, 'start');
    const { stdout } = await this.execFile(
      'systemctl',
      [
        '--user',
        'show',
        unit,
        '--property',
        'Description,LoadState,ActiveState,SubState,UnitFileState',
      ],
      { cwd: this.rootDir, timeout: 15_000 },
    );
    return parseSystemdShowOutput(stdout, unit);
  }

  async listPresetSummaries(): Promise<PresetSummary[]> {
    await this.fs.mkdir(this.runtimePresetDirPath, { recursive: true });
    const presets = await this.readPresetSummariesFromDisk();
    const order = await this.readPresetOrder();
    return this.sortPresetSummaries(presets, order);
  }

  private async readPresetSummariesFromDisk(): Promise<PresetSummary[]> {
    const presets = new Map<string, PresetSummary>();
    for (const dirPath of this.allPresetDirPaths) {
      let entries: Array<{ isFile(): boolean; name: string }>;
      try {
        entries = (await this.fs.readdir(dirPath, { withFileTypes: true })) as Array<{ isFile(): boolean; name: string }>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
          continue;
        }
        throw error;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.yml')) continue;
        const name = entry.name.slice(0, -4);
        if (presets.has(name)) continue;
        presets.set(name, {
          name,
          path: join(dirPath, entry.name),
          source: dirPath === this.runtimePresetDirPath ? 'runtime' : 'bundled',
        });
      }
    }

    return [...presets.values()];
  }

  private sortPresetSummaries(presets: PresetSummary[], order: readonly string[]): PresetSummary[] {
    const rank = new Map(order.map((name, index) => [name, index]));
    return [...presets].sort((left, right) => {
      const leftRank = rank.get(left.name);
      const rightRank = rank.get(right.name);
      if (leftRank != null || rightRank != null) {
        if (leftRank == null) return 1;
        if (rightRank == null) return -1;
        return leftRank - rightRank;
      }
      return left.name.localeCompare(right.name, 'zh-CN');
    });
  }

  private async readPresetOrder(): Promise<string[]> {
    try {
      const raw = await this.fs.readFile(this.getPresetOrderFilePath(), 'utf8');
      const parsed = JSON.parse(raw) as PresetOrderDocument;
      return Array.isArray(parsed?.names)
        ? [...new Set(parsed.names.map((name) => String(name ?? '').trim()).filter(Boolean))]
        : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') return [];
      return [];
    }
  }

  private async writePresetOrder(names: readonly string[]): Promise<void> {
    const filePath = this.getPresetOrderFilePath();
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    const content = `${JSON.stringify({ names }, null, 2)}\n`;
    await this.fs.mkdir(this.runtimePresetDirPath, { recursive: true });
    await this.fs.writeFile(tempPath, content, 'utf8');
    await this.fs.rename(tempPath, filePath);
  }

  private async updatePresetOrder(mutator: (names: string[]) => string[]): Promise<void> {
    const current = await this.readPresetOrder();
    const next = [...new Set(mutator([...current]).map((name) => name.trim()).filter(Boolean))];
    await this.writePresetOrder(next);
  }

  private getPresetOrderFilePath(): string {
    return join(this.runtimePresetDirPath, PRESET_ORDER_FILENAME);
  }

  resolvePresetPath(name: string): string {
    return this.resolveRuntimePresetPath(name);
  }

  resolveRuntimePresetPath(name: string): string {
    return join(this.runtimePresetDirPath, `${name}.yml`);
  }

  private async assertPresetExists(name: string): Promise<void> {
    const filePath = this.resolveRuntimePresetPath(name);
    await this.fs.access(filePath, fsConstants.F_OK);
  }

  private async findPresetSummaryByName(name: string): Promise<PresetSummary | null> {
    const presets = await this.readPresetSummariesFromDisk();
    return presets.find((preset) => preset.name === name) ?? null;
  }

  private async findBundledPresetSummaryByName(name: string): Promise<PresetSummary | null> {
    for (const dirPath of this.bundledPresetDirPaths) {
      const filePath = join(dirPath, `${name}.yml`);
      try {
        await this.fs.access(filePath, fsConstants.F_OK);
        return { name, path: filePath, source: 'bundled' };
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
          throw error;
        }
      }
    }
    return null;
  }

  private async buildModelTabsPatch(input: SaveModelTabsRequest): Promise<EnvPatch> {
    const activeTab = normalizeMainChatBuiltinTabId(input?.activeTab) as BotConsoleModelTabId;
    const providedTabs = Array.isArray(input?.tabs) ? input.tabs : [];
    const tabs = providedTabs.map((item) => normalizeModelTabInput(item));

    if (this.copilotBridge) {
      const runtime = await this.copilotBridge.getRuntimeConfig();
      const copilotTab = findRequiredModelTab(tabs, 'copilot');
      copilotTab.baseUrl = runtime.baseUrl;
      copilotTab.apiKey = runtime.apiKey;
    }

    findRequiredModelTab(tabs, 'siliconflow');
    findRequiredModelTab(tabs, 'openai');
    findRequiredModelTab(tabs, 'copilot');
    return buildMainChatRuntimeEnvPatch(activeTab, tabs);
  }

  private async decorateModelTabsState(state: BotConsoleModelTabsState): Promise<BotConsoleModelTabsState> {
    if (!this.copilotBridge) {
      return state;
    }

    const runtime = await this.copilotBridge.getRuntimeConfig();
    const consoleState = await this.copilotBridge.getConsoleStatus({ probe: false });
    return {
      activeTab: state.activeTab,
      tabs: state.tabs.map((tab) => {
        if (tab.id !== 'copilot') return tab;
        return {
          ...tab,
          authKind: consoleState.authKind,
          authStatus: consoleState.authStatus,
          accountLabel: consoleState.accountLabel,
          authError: consoleState.authError,
          baseUrl: runtime.baseUrl,
          apiKey: runtime.apiKey,
        };
      }),
    };
  }
}
