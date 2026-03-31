import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('chatluna responses input regression', () => {
  it('keeps responses-mode multimodal content mapped to input_* item types', () => {
    const packageJsonPath = require.resolve('koishi-plugin-chatluna/package.json');
    const packageRoot = dirname(packageJsonPath);
    const sharedAdapterSource = readFileSync(join(packageRoot, '..', 'shared-adapter', 'src', 'utils.ts'), 'utf8');
    const sharedAdapterRequesterSource = readFileSync(join(packageRoot, '..', 'shared-adapter', 'src', 'requester.ts'), 'utf8');
    const sharedAdapterBundle = readFileSync(join(packageRoot, '..', 'shared-adapter', 'lib', 'index.mjs'), 'utf8');

    expect(sharedAdapterSource).toContain('normalizeResponsesMessageContent');
    expect(sharedAdapterSource).toContain("type: 'input_text'");
    expect(sharedAdapterSource).toContain("type: 'input_image'");
    expect(sharedAdapterRequesterSource).toContain("type === 'image_url' || type === 'input_image'");

    expect(sharedAdapterBundle).toContain('normalizeResponsesMessageContent');
    expect(sharedAdapterBundle).toContain('type: "input_text"');
    expect(sharedAdapterBundle).toContain('type: "input_image"');
    expect(sharedAdapterBundle).toContain('type === "image_url" || type === "input_image"');
  });
});
