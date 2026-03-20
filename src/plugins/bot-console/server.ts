import { constants as fsConstants } from 'node:fs';
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
import { dirname, join, resolve } from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import type {
  BotConsoleState,
  BotServiceStatus,
  BotServiceUnit,
  EnvPatch,
  PresetDocument,
  PresetSummary,
  ServiceAction,
} from '../../types/bot-console.js';

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
  presetDirPath?: string;
  fs?: FsLike;
  execFile?: (file: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;
};

type EnvLine =
  | { type: 'kv'; key: string; rawValue: string }
  | { type: 'other'; value: string };

type BotConsoleStaticState = {
  env: Record<string, string>;
  services: BotServiceStatus[];
  presets: PresetSummary[];
  defaultPreset: string;
};

const DEFAULT_ROOT_DIR = resolve(process.cwd());
const ENV_FILE_BASENAME = '.env.local';
const PRESET_DIR_RELATIVE = 'data/chathub/presets';
const PRESET_ROLE_SET = new Set(['system', 'user', 'assistant', 'tool']);

export const BOT_CONSOLE_ENV_FIELDS: ManagedEnvField[] = [
  { key: 'QQ_VOICE_ENABLED', label: 'QQ 语音总开关', type: 'toggle', section: 'features' },
  { key: 'QQ_VOICE_INPUT_ENABLED', label: '语音转文字', type: 'toggle', section: 'features' },
  { key: 'QQ_VOICE_OUTPUT_ENABLED', label: '语音回复', type: 'toggle', section: 'features' },
  { key: 'POKEMON_BATTLE_ENABLED', label: '宝可梦对战', type: 'toggle', section: 'features' },
  { key: 'CHAT_NATURAL_TRIGGER_ENABLED', label: '群聊自然触发', type: 'toggle', section: 'features' },
  { key: 'TASK_AUTOMATION_INTENT_ENABLED', label: '任务意图识别', type: 'toggle', section: 'features' },
  { key: 'OPENAI_BASE_URL', label: '模型接口地址', type: 'text', section: 'model' },
  { key: 'OPENAI_API_KEY', label: '模型接口密钥', type: 'secret', section: 'model' },
  { key: 'OPENAI_MODEL', label: '默认模型', type: 'text', section: 'model' },
  { key: 'TASK_AUTOMATION_INTENT_MODEL', label: '任务意图模型', type: 'text', section: 'model' },
  { key: 'TASK_AUTOMATION_DELIVERY_MODEL', label: '任务投递模型', type: 'text', section: 'model' },
  { key: 'TASK_AUTOMATION_CHAT_REPLY_MODEL', label: '任务回复模型', type: 'text', section: 'model' },
  { key: 'CHATLUNA_DEFAULT_MODEL', label: '对话默认模型', type: 'text', section: 'model' },
  { key: 'CHATLUNA_DEFAULT_PRESET', label: '默认预设', type: 'text', section: 'model' },
  { key: 'CHAT_ENABLED_GROUPS', label: '自动化启用群', type: 'text', section: 'basic' },
  { key: 'CHAT_NATURAL_TRIGGER_GROUPS', label: '自然触发群', type: 'text', section: 'basic' },
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
  const result: Record<string, string> = {};
  for (const key of BOT_CONSOLE_ENV_KEYS) {
    result[key] = '';
  }

  for (const line of parseEnvLines(content)) {
    if (line.type !== 'kv' || !BOT_CONSOLE_ENV_KEYS.has(line.key)) continue;
    result[line.key] = parseEnvValue(line.rawValue);
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
  await fsLike.copyFile(filePath, backupPath);

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

export function parsePresetDocument(name: string, path: string, raw: string): PresetDocument {
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
    raw,
    keywords,
    prompts,
  });
}

export class BotConsoleManager {
  readonly rootDir: string;
  readonly envFilePath: string;
  readonly presetDirPath: string;
  readonly fs: FsLike;
  readonly execFile: (file: string, args: string[], options?: { cwd?: string; timeout?: number }) => Promise<ExecResult>;

  constructor(options: BotConsoleManagerOptions = {}) {
    this.rootDir = options.rootDir ? resolve(options.rootDir) : DEFAULT_ROOT_DIR;
    this.envFilePath = options.envFilePath ?? join(this.rootDir, ENV_FILE_BASENAME);
    this.presetDirPath = options.presetDirPath ?? join(this.rootDir, PRESET_DIR_RELATIVE);
    this.fs = options.fs ?? defaultFs();
    this.execFile = options.execFile ?? defaultExec;
  }

  async getState(): Promise<BotConsoleStaticState> {
    const [envContent, presets, services] = await Promise.all([
      this.fs.readFile(this.envFilePath, 'utf8'),
      this.listPresetSummaries(),
      this.getServiceStatuses(),
    ]);

    const env = readManagedEnvFromContent(envContent);
    return {
      env,
      services,
      presets,
      defaultPreset: env.CHATLUNA_DEFAULT_PRESET || 'sakiko',
    };
  }

  async getPreset(name: string): Promise<PresetDocument> {
    const normalized = normalizePresetDocument({ name, keywords: [], prompts: [{ role: 'system', content: 'x' }] }).name;
    const filePath = this.resolvePresetPath(normalized);
    const raw = await this.fs.readFile(filePath, 'utf8');
    return parsePresetDocument(normalized, filePath, raw);
  }

  async saveEnv(patch: EnvPatch): Promise<Record<string, string>> {
    const content = await this.fs.readFile(this.envFilePath, 'utf8');
    const next = applyEnvPatchToContent(content, patch);
    await writeFileAtomicWithBackup(this.envFilePath, next, this.fs);
    return readManagedEnvFromContent(next);
  }

  async savePreset(document: PresetDocument): Promise<PresetDocument> {
    const normalized = normalizePresetDocument(document);
    const targetPath = this.resolvePresetPath(normalized.name);
    const sourceName = normalized.originalName?.trim() || normalized.name;

    if (sourceName !== normalized.name) {
      await this.assertPresetExists(sourceName);
    }

    const raw = serializePresetDocument(normalized);
    await this.fs.mkdir(this.presetDirPath, { recursive: true });
    await this.fs.writeFile(targetPath, raw, 'utf8');

    if (sourceName !== normalized.name) {
      const sourcePath = this.resolvePresetPath(sourceName);
      await this.fs.rm(sourcePath, { force: true });
    }

    return {
      ...normalized,
      path: targetPath,
      raw,
    };
  }

  async deletePreset(name: string, defaultPreset: string): Promise<void> {
    const normalized = normalizePresetDocument({ name, keywords: [], prompts: [{ role: 'system', content: 'x' }] }).name;
    if (normalized === defaultPreset) {
      throw new Error('不能删除当前正在使用的默认预设。');
    }
    await this.assertPresetExists(normalized);
    await this.fs.rm(this.resolvePresetPath(normalized), { force: true });
  }

  async runServiceAction(unit: BotServiceUnit, action: ServiceAction): Promise<BotServiceStatus> {
    validateServiceAction(unit, action);
    if (unit === 'qqbot.target' && action === 'restart') {
      await this.execFile('systemctl', ['--user', 'stop', unit], { cwd: this.rootDir, timeout: 15_000 });
      await this.execFile('systemctl', ['--user', 'start', unit], { cwd: this.rootDir, timeout: 15_000 });
      return this.getServiceStatus(unit);
    }
    await this.execFile('systemctl', ['--user', action, unit], { cwd: this.rootDir, timeout: 15_000 });
    return this.getServiceStatus(unit);
  }

  async getRecentLogs(limit = 200): Promise<string[]> {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 200;
    const { stdout } = await this.execFile(
      'journalctl',
      [
        '--user',
        '-u',
        'qqbot-koishi.service',
        '-n',
        String(safeLimit),
        '--no-pager',
        '--output',
        'short-precise',
      ],
      { cwd: this.rootDir, timeout: 15_000 },
    );

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
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
    await this.fs.mkdir(this.presetDirPath, { recursive: true });
    const entries = await this.fs.readdir(this.presetDirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yml'))
      .map((entry) => ({
        name: entry.name.slice(0, -4),
        path: join(this.presetDirPath, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  resolvePresetPath(name: string): string {
    return join(this.presetDirPath, `${name}.yml`);
  }

  private async assertPresetExists(name: string): Promise<void> {
    const filePath = this.resolvePresetPath(name);
    await this.fs.access(filePath, fsConstants.F_OK);
  }
}
