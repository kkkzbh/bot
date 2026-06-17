import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('affinity configuration', () => {
  it('loads the affinity runtime plugin before long-term memory', () => {
    const content = readFileSync(resolve(process.cwd(), 'koishi.yml'), 'utf8');
    const affinityIndex = content.indexOf('./dist/plugins/affinity:affinity:');
    const memoryIndex = content.indexOf('./dist/plugins/memory:memory:');

    expect(affinityIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeGreaterThan(affinityIndex);
    expect(content).toContain('randomWindowStartHour: ${{ +env.AFFINITY_RANDOM_WINDOW_START_HOUR || 8 }}');
    expect(content).toContain('randomWindowEndHour: ${{ +env.AFFINITY_RANDOM_WINDOW_END_HOUR || 22 }}');
  });

  it('adds the relationship events console tab', () => {
    const content = readFileSync(resolve(process.cwd(), 'src/plugins/bot-console/client/App.vue'), 'utf8');

    expect(content).toContain("import AffinityPanel from './components/panels/AffinityPanel.vue'");
    expect(content).toContain("{ id: 'affinity', label: '关系事件' }");
    expect(content).toContain('affinity: AffinityPanel');
  });
});
