import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { isAffinityPanelCommandSession, registerAffinityPanelCommand } from '../src/plugins/affinity/index.js';
import type { AffinityPanelView, AffinityServiceLike } from '../src/types/affinity.js';

vi.mock('koishi', () => {
  class MockLogger {
    warn(): void {}
    info(): void {}
  }
  const schemaChain = new Proxy(() => schemaChain, {
    get: () => schemaChain,
    apply: () => schemaChain,
  }) as any;
  const Schema = new Proxy({}, {
    get: () => schemaChain,
  }) as any;
  return {
    Context: class {},
    Logger: MockLogger,
    Schema,
    h: {
      image: (buffer: Buffer, mime: string) => ({
        type: 'image',
        attrs: { buffer, mime },
        toString: () => `<image mime="${mime}"/>`,
      }),
    },
  };
});

vi.mock('koishi-plugin-chatluna/chains', () => ({
  ChainMiddlewareRunStatus: { CONTINUE: 0 },
}));

function createPanelView(overrides: Partial<AffinityPanelView> = {}): AffinityPanelView {
  return {
    characterId: 'sakiko',
    userKey: 'onebot:alice',
    stage: 'remembered',
    stageName: '被记住的人',
    stageIcon: '◆',
    lastRelationChange: '12分钟前',
    axes: [
      { name: '信赖', value: 43, tone: 'wine', icon: '◆' },
      { name: '熟悉', value: 58, tone: 'teal', icon: '✦' },
      { name: '安心', value: 36, tone: 'blue', icon: '☾' },
      { name: '紧张', value: 18, tone: 'gold', icon: '!' },
    ],
    rhythm: [
      { label: '心情', value: '专注', icon: '◇' },
      { label: '热度', value: '偏高', icon: '▲' },
      { label: '体力', value: '72', icon: '∿' },
    ],
    recentEvents: [{
      time: '12分钟前',
      title: '承接了她主动打开的话题',
      icon: '✦',
      effects: [{ name: '信赖', sign: '+' }],
    }],
    adviceIcon: '◆',
    advice: '低频、认真地回应她已经打开的话题。',
    lineKind: 'remembered',
    fixedLine: '你之前说过的事，我多少还记得一点。',
    ...overrides,
  };
}

function createPuppeteerHarness() {
  let navigatedHtml = '';
  const element = {
    boundingBox: vi.fn(async () => ({ x: 0, y: 0, width: 900, height: 1160 })),
  };
  const page = {
    setViewport: vi.fn(async () => undefined),
    setContent: vi.fn(async (_content: string, _options?: unknown) => undefined),
    goto: vi.fn(async (url: string) => {
      navigatedHtml = readFileSync(fileURLToPath(url), 'utf8');
    }),
    waitForSelector: vi.fn(async () => undefined),
    $: vi.fn(async () => element),
    screenshot: vi.fn(async () => Buffer.from('png')),
    close: vi.fn(async () => undefined),
  };
  return {
    page,
    puppeteer: {
      page: vi.fn(async () => page),
    },
    getNavigatedHtml: () => navigatedHtml,
  };
}

describe('affinity panel command', () => {
  it('wires the exact 好感 command skip before incoming relationship analysis', () => {
    const source = readFileSync(join(process.cwd(), 'src/plugins/affinity/index.ts'), 'utf8');
    expect(source).toContain('if (!isAffinityPanelCommandSession(session))');
    expect(source).toContain('await service.processIncomingSession(session);');
  });

  it('identifies the exact 好感 command so incoming affinity analysis can skip it', () => {
    expect(isAffinityPanelCommandSession({ content: '好感' } as any)).toBe(true);
    expect(isAffinityPanelCommandSession({ stripped: { content: ' 好感 ' }, content: '<at id="bot"/> 好感' } as any)).toBe(true);
    expect(isAffinityPanelCommandSession({ content: '好感度' } as any)).toBe(false);
    expect(isAffinityPanelCommandSession({ content: '看看好感' } as any)).toBe(false);
  });

  it('registers 好感 and sends panel image before the fixed line', async () => {
    const panelView = createPanelView();
    const service = {
      buildPanelView: vi.fn(async () => panelView),
      syncPanelCommandToChatHistory: vi.fn(async () => ({ synced: true, conversationId: 'conv-affinity' })),
    } as unknown as AffinityServiceLike;
    const { page, puppeteer, getNavigatedHtml } = createPuppeteerHarness();
    let action: ((argv: { session?: any }) => Promise<unknown>) | null = null;
    const command = vi.fn((_name: string) => ({
      action: vi.fn((callback) => {
        action = callback;
      }),
    }));
    const logger = { warn: vi.fn() };
    registerAffinityPanelCommand({ command, puppeteer }, service, logger as any);

    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenCalledWith('好感', '查看与丰川祥子的关系面板');
    expect(action).toBeTruthy();

    const sent: unknown[] = [];
    const session = {
      userId: 'alice',
      send: vi.fn(async (message: unknown) => {
        sent.push(message);
      }),
    };
    const result = await action!({ session });

    expect(result).toBeUndefined();
    expect(service.buildPanelView).toHaveBeenCalledWith(session);
    expect(page.setContent).not.toHaveBeenCalled();
    expect(page.goto).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\//), { waitUntil: 'networkidle0' });
    expect(getNavigatedHtml()).toContain('承接了她主动打开的话题');
    expect(getNavigatedHtml()).toContain('panel-banner.png');
    expect(sent).toHaveLength(2);
    expect(String(sent[0])).toContain('image');
    expect(sent[1]).toBe(panelView.fixedLine);
    expect(service.syncPanelCommandToChatHistory).toHaveBeenCalledWith(session, panelView);
    expect(page.close).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not send a line when panel generation fails', async () => {
    const service = {
      buildPanelView: vi.fn(async () => {
        throw new Error('renderer unavailable');
      }),
      syncPanelCommandToChatHistory: vi.fn(async () => ({ synced: true })),
    } as unknown as AffinityServiceLike;
    const { puppeteer } = createPuppeteerHarness();
    let action: ((argv: { session?: any }) => Promise<unknown>) | null = null;
    const command = vi.fn((_name: string) => ({
      action: vi.fn((callback) => {
        action = callback;
      }),
    }));
    const logger = { warn: vi.fn() };
    registerAffinityPanelCommand({ command, puppeteer }, service, logger as any);

    const session = {
      userId: 'alice',
      send: vi.fn(async () => undefined),
    };
    const result = await action!({ session });

    expect(result).toBe('关系面板生成失败。');
    expect(session.send).not.toHaveBeenCalled();
    expect(service.syncPanelCommandToChatHistory).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('affinity panel command failed: %s', 'renderer unavailable');
  });
});
