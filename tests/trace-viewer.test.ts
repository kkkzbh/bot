import { describe, expect, it, vi } from 'vitest';

vi.mock('@koishijs/plugin-server', () => ({}));

vi.mock('koishi', () => {
  type MockSchemaNode = {
    default: () => MockSchemaNode;
    description: () => MockSchemaNode;
    min: () => MockSchemaNode;
    max: () => MockSchemaNode;
    role: () => MockSchemaNode;
  };

  const createSchemaNode = (): MockSchemaNode => ({
    default: () => createSchemaNode(),
    description: () => createSchemaNode(),
    min: () => createSchemaNode(),
    max: () => createSchemaNode(),
    role: () => createSchemaNode(),
  });

  class MockLogger {
    info(): void {}
    warn(): void {}
    error(): void {}
    debug(): void {}
  }

  return {
    Context: class {},
    Logger: MockLogger,
    Schema: {
      object: () => createSchemaNode(),
      boolean: () => createSchemaNode(),
      string: () => createSchemaNode(),
      natural: () => createSchemaNode(),
    },
  };
});

import type { TraceEventRecord } from '../src/types/trace-viewer.js';
import {
  buildTraceEventsResponse,
  extractInjectedPrompts,
  isAllowedRemoteAddress,
  serializePayload,
  trimText,
} from '../src/plugins/trace-viewer.js';

function createEvent(overrides: Partial<TraceEventRecord>): TraceEventRecord {
  return {
    id: 1,
    traceId: 'trace-1',
    seq: 1,
    phase: 'prepare',
    kind: 'chatluna-time-context',
    payload: '{}',
    truncated: 0,
    createdAt: Date.UTC(2024, 0, 2, 3, 4, 5),
    ...overrides,
  };
}

describe('trace viewer helpers', () => {
  it('allows loopback and private network addresses only', () => {
    expect(isAllowedRemoteAddress('127.0.0.1')).toBe(true);
    expect(isAllowedRemoteAddress('192.168.1.20')).toBe(true);
    expect(isAllowedRemoteAddress('100.99.0.12')).toBe(true);
    expect(isAllowedRemoteAddress('8.8.8.8')).toBe(false);
  });

  it('redacts obvious secrets and truncates oversized payloads', () => {
    const serialized = serializePayload(
      {
        apiKey: 'sk-secret',
        nested: { authorization: 'Bearer xxx' },
        text: 'x'.repeat(300),
      },
      120,
      true,
    );

    expect(serialized.truncated).toBe(1);
    expect(serialized.text).toContain('[redacted]');
    expect(serialized.text).toContain('[truncated]');
    expect(serialized.text).not.toContain('sk-secret');
  });

  it('trims long previews with an ellipsis', () => {
    expect(trimText('abc', 10)).toBe('abc');
    expect(trimText('abcdefghijk', 5)).toBe('abcd…');
  });

  it('extracts injected prompts from input rewrites and context injections in order', () => {
    const prompts = extractInjectedPrompts([
      createEvent({
        seq: 1,
        kind: 'chatluna-time-context',
        payload: JSON.stringify({
          injectedContent: '用户: 小祥\n时间: 2026-03-16 12:00\n消息: 现在几点了',
        }),
      }),
      createEvent({
        id: 2,
        seq: 2,
        kind: 'context-injection',
        payload: JSON.stringify({
          source: 'qqbot_reply_transport_policy',
          stage: 'after_scratchpad',
          content: '本轮语音回复可用。如果你决定发送一条语音回复，就直接输出 ReplyPlan JSON。',
        }),
      }),
    ]);

    expect(prompts).toEqual([
      {
        source: 'chatluna-time-context',
        sourceLabel: 'Input rewrite',
        stage: 'input-message',
        content: '用户: 小祥\n时间: 2026-03-16 12:00\n消息: 现在几点了',
        createdAt: Date.UTC(2024, 0, 2, 3, 4, 5),
      },
      {
        source: 'qqbot_reply_transport_policy',
        sourceLabel: 'Reply transport policy',
        stage: 'after_scratchpad',
        content: '本轮语音回复可用。如果你决定发送一条语音回复，就直接输出 ReplyPlan JSON。',
        createdAt: Date.UTC(2024, 0, 2, 3, 4, 5),
      },
    ]);
  });

  it('ignores malformed injected prompt events safely', () => {
    const prompts = extractInjectedPrompts([
      createEvent({
        seq: 1,
        kind: 'chatluna-time-context',
        payload: JSON.stringify({ userName: '小祥' }),
      }),
      createEvent({
        id: 2,
        seq: 2,
        kind: 'context-injection',
        payload: JSON.stringify({ source: 'qqbot_sticker_policy', stage: 'after_scratchpad' }),
      }),
      createEvent({
        id: 3,
        seq: 3,
        kind: 'context-injection',
        payload: 'not-json',
      }),
    ]);

    expect(prompts).toEqual([]);
  });

  it('serializes trace event responses with injected prompts alongside events', () => {
    const response = buildTraceEventsResponse([
      createEvent({
        seq: 1,
        kind: 'chatluna-time-context',
        payload: JSON.stringify({ injectedContent: '改写后的用户输入' }),
      }),
      createEvent({
        id: 2,
        seq: 2,
        kind: 'llm-output',
        phase: 'llm-output',
        payload: JSON.stringify({ text: '你好' }),
      }),
    ]);

    expect(response.events).toHaveLength(2);
    expect(response.events[0]).toMatchObject({
      kind: 'chatluna-time-context',
      createdAtText: expect.any(String),
    });
    expect(response.injectedPrompts).toEqual([
      {
        source: 'chatluna-time-context',
        sourceLabel: 'Input rewrite',
        stage: 'input-message',
        content: '改写后的用户输入',
        createdAt: Date.UTC(2024, 0, 2, 3, 4, 5),
        createdAtText: expect.any(String),
      },
    ]);
  });
});
