import '@koishijs/plugin-console';
import { join } from 'node:path';
import { Context, Logger } from 'koishi';
import { BotConsoleManager } from './server.js';
import type {
  BotConsoleProbeResult,
  BotConsoleState,
  BotServiceUnit,
  ClearConversationHistoryRequest,
  ClearConversationHistoryResponse,
  DeleteConversationRoomRequest,
  DeleteConversationRoomResponse,
  EnvPatch,
  GetRecentLogsResponse,
  PresetDocument,
  ReorderPresetsResponse,
  SaveFeatureOverridesRequest,
  SaveFeatureOverridesResponse,
  SaveToolOverridesRequest,
  SaveToolOverridesResponse,
  ServiceAction,
} from '../../types/bot-console.js';
import type { FeaturePolicyServiceLike } from '../../types/feature-policy.js';
import type { MemoryV2StatusServiceLike } from '../../types/memory-v2.js';
import type { ToolPolicyServiceLike } from '../../types/tool-policy.js';
import { createUnavailableMemoryV2StatusSnapshot } from '../memory/status.js';

const logger = new Logger('bot-console');

export const name = 'bot-console';
export const inject = { required: ['console'], optional: ['memoryV2Status', 'featurePolicy', 'toolPolicy'] } as const;

const LISTENER_AUTHORITY = 4;

function ensureRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('请求数据格式不正确。');
  }
  return value as Record<string, unknown>;
}

type ContextWithRuntimeServices = Context & {
  memoryV2Status?: MemoryV2StatusServiceLike;
  featurePolicy?: FeaturePolicyServiceLike;
  toolPolicy?: ToolPolicyServiceLike;
};

async function buildState(ctx: ContextWithRuntimeServices, manager: BotConsoleManager): Promise<BotConsoleState> {
  const [state, memoryV2, featureScopes, featureOverrides, conversationTargets, toolPolicy] = await Promise.all([
    manager.getState(),
    ctx.memoryV2Status
      ? ctx.memoryV2Status.getSnapshot().catch(() => createUnavailableMemoryV2StatusSnapshot())
      : Promise.resolve(createUnavailableMemoryV2StatusSnapshot()),
    ctx.featurePolicy?.listConsoleFeatureScopes?.() ?? Promise.resolve([]),
    ctx.featurePolicy?.getFeatureOverrides?.() ?? Promise.resolve([]),
    ctx.featurePolicy?.listConversationTargets?.() ?? Promise.resolve([]),
    ctx.toolPolicy?.getToolPolicyState?.() ?? Promise.resolve({
      catalog: [],
      routeProfiles: [],
      routeProfileInfo: [],
      defaultScopes: [],
      scopes: [],
      overrides: [],
      conversationTargets: [],
    }),
  ]);

  return {
    ...state,
    featureScopes,
    featureOverrides,
    conversationTargets,
    toolPolicy: {
      ...toolPolicy,
      conversationTargets: toolPolicy.conversationTargets.length > 0 ? toolPolicy.conversationTargets : conversationTargets,
    },
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
    'bot-console/save-feature-overrides',
    async (payload: SaveFeatureOverridesRequest): Promise<SaveFeatureOverridesResponse> => {
      if (!runtimeCtx.featurePolicy?.saveFeatureOverrides) {
        throw new Error('feature policy service unavailable');
      }
      const record = ensureRecord(payload);
      const overrides = Array.isArray(record.overrides) ? (record.overrides as SaveFeatureOverridesRequest['overrides']) : [];
      const nextOverrides = await runtimeCtx.featurePolicy.saveFeatureOverrides(overrides);
      return { overrides: nextOverrides };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/get-tool-policy-state',
    async () => {
      if (runtimeCtx.toolPolicy?.getToolPolicyState) {
        return runtimeCtx.toolPolicy.getToolPolicyState();
      }
      const conversationTargets = runtimeCtx.featurePolicy?.listConversationTargets
        ? await runtimeCtx.featurePolicy.listConversationTargets()
        : [];
      return {
        catalog: [],
        routeProfiles: [],
        routeProfileInfo: [],
        defaultScopes: [],
        scopes: [],
        overrides: [],
        conversationTargets,
      };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/save-tool-overrides',
    async (payload: SaveToolOverridesRequest): Promise<SaveToolOverridesResponse> => {
      if (!runtimeCtx.toolPolicy?.saveToolOverrides) {
        throw new Error('tool policy service unavailable');
      }
      const record = ensureRecord(payload);
      const overrides = Array.isArray(record.overrides) ? (record.overrides as SaveToolOverridesRequest['overrides']) : [];
      const nextOverrides = await runtimeCtx.toolPolicy.saveToolOverrides(overrides);
      return { overrides: nextOverrides };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/clear-conversation-history',
    async (payload: ClearConversationHistoryRequest): Promise<ClearConversationHistoryResponse> => {
      if (!runtimeCtx.featurePolicy?.clearConversationHistory) {
        throw new Error('feature policy service unavailable');
      }
      const record = ensureRecord(payload);
      const result = await runtimeCtx.featurePolicy.clearConversationHistory({
        roomId: Number(record.roomId ?? 0),
        conversationId: String(record.conversationId ?? ''),
      });
      return { result };
    },
    { authority: LISTENER_AUTHORITY },
  );

  consoleService.addListener(
    'bot-console/delete-conversation-room',
    async (payload: DeleteConversationRoomRequest): Promise<DeleteConversationRoomResponse> => {
      if (!runtimeCtx.featurePolicy?.deleteConversationRoom) {
        throw new Error('feature policy service unavailable');
      }
      const record = ensureRecord(payload);
      const result = await runtimeCtx.featurePolicy.deleteConversationRoom({
        roomId: Number(record.roomId ?? 0),
        conversationId: String(record.conversationId ?? ''),
      });
      return { result };
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
    'bot-console/reorder-presets',
    async (payload: unknown): Promise<ReorderPresetsResponse> => {
      const record = ensureRecord(payload);
      const names = Array.isArray(record.names) ? record.names.map((item) => String(item ?? '')) : [];
      const presets = await manager.reorderPresets(names);
      return { presets };
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

  consoleService.addListener(
    'bot-console/get-recent-logs',
    async (): Promise<GetRecentLogsResponse> => {
      const lines = await manager.getRecentLogs();
      return { lines };
    },
    { authority: LISTENER_AUTHORITY },
  );

  logger.info('bot console extension registered.');
}
