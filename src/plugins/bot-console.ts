import '@koishijs/plugin-console';
import { join } from 'node:path';
import { Context, Logger } from 'koishi';
import { BotConsoleManager } from './bot-console-core.js';
import type { BotConsoleProbeResult, BotConsoleState, BotServiceUnit, EnvPatch, PresetDocument, ServiceAction } from '../types/bot-console.js';
import type { MemoryV2StatusServiceLike } from '../types/memory-v2.js';
import { createUnavailableMemoryV2StatusSnapshot } from './memory-v2-status.js';

const logger = new Logger('bot-console');

export const name = 'bot-console';
export const inject = { required: ['console'], optional: ['memoryV2Status'] } as const;

const LISTENER_AUTHORITY = 4;

function ensureRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('请求数据格式不正确。');
  }
  return value as Record<string, unknown>;
}

type ContextWithRuntimeServices = Context & {
  memoryV2Status?: MemoryV2StatusServiceLike;
};

async function buildState(ctx: ContextWithRuntimeServices, manager: BotConsoleManager): Promise<BotConsoleState> {
  const state = await manager.getState();
  const memoryV2 = ctx.memoryV2Status
    ? await ctx.memoryV2Status.getSnapshot().catch(() => createUnavailableMemoryV2StatusSnapshot())
    : createUnavailableMemoryV2StatusSnapshot();

  return {
    ...state,
    runtimeStatus: {
      memoryV2,
    },
  };
}

export function apply(ctx: Context): void {
  const manager = new BotConsoleManager({ rootDir: ctx.baseDir });
  const consoleService = ctx.console as any;
  const runtimeCtx = ctx as ContextWithRuntimeServices;
  const entryDir = join(ctx.baseDir, 'node_modules/.cache/qqbot-bot-console');

  consoleService.addEntry(
    {
      dev: join(entryDir, 'index.js'),
      prod: entryDir,
    },
    () => ({
      title: '机器人控制台',
    }),
  );

  consoleService.addListener(
    'bot-console/get-state',
    async () => {
      return buildState(runtimeCtx, manager);
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/run-status-probe',
    async (target: string): Promise<BotConsoleProbeResult> => {
      if (String(target ?? '') !== 'embedding') {
        throw new Error('不支持这个探测目标。');
      }

      const memoryV2 =
        runtimeCtx.memoryV2Status?.probeEmbedding != null
          ? await runtimeCtx.memoryV2Status.probeEmbedding()
          : {
              target: 'embedding' as const,
              ok: false,
              checkedAt: Date.now(),
              latencyMs: null,
              error: 'memory-v2 status service unavailable',
              snapshot: createUnavailableMemoryV2StatusSnapshot(),
            };

      return {
        target: 'embedding',
        memoryV2,
      };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/get-preset',
    async (name: string) => {
      return manager.getPreset(String(name ?? ''));
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/save-env',
    async (payload: unknown) => {
      const record = ensureRecord(payload);
      const patch: EnvPatch = {};
      for (const [key, value] of Object.entries(record)) {
        patch[key] = value == null ? null : String(value);
      }
      const env = await manager.saveEnv(patch);
      return { env, restartRequired: true };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/validate-preset',
    async (payload: unknown) => {
      return manager.validatePreset(ensureRecord(payload) as unknown as PresetDocument);
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/save-preset',
    async (payload: unknown) => {
      const preset = await manager.savePreset(ensureRecord(payload) as unknown as PresetDocument);
      return { preset, restartRequired: true };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/delete-preset',
    async (name: string, defaultPreset: string) => {
      await manager.deletePreset(String(name ?? ''), String(defaultPreset ?? ''));
      return { ok: true, restartRequired: true };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/service-action',
    async (unit: BotServiceUnit, action: ServiceAction) => {
      const status = await manager.runServiceAction(unit, action);
      return { status };
    },
    { authority: LISTENER_AUTHORITY },
  );

  logger.info('bot console extension registered.');
}
