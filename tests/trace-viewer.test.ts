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

import { isAllowedRemoteAddress, serializePayload, trimText } from '../src/plugins/trace-viewer.js';

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
});
