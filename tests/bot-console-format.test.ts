import { describe, expect, it } from 'vitest';
import { formatErrorMessage } from '../src/plugins/bot-console/client/utils/format.js';

describe('bot-console client formatting helpers', () => {
  it('preserves message fields from serialized errors', () => {
    expect(formatErrorMessage({ message: '写入失败' }, '保存失败')).toBe('写入失败');
    expect(formatErrorMessage({ error: { message: '权限不足' } }, '保存失败')).toBe('权限不足');
  });

  it('formats websocket-style failure events as connection failures', () => {
    expect(formatErrorMessage({ type: 'error' }, '保存失败')).toBe('管理台连接已断开，请刷新页面后重试。');
    expect(formatErrorMessage({ type: 'close' }, '保存失败')).toBe('管理台连接已断开，请刷新页面后重试。');
  });
});
