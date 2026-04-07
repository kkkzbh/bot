import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveChatlunaSiblingPackageRoot } from './helpers/chatluna-paths.js';

describe('chatluna responses input regression', () => {
  it('keeps responses-mode multimodal content mapped to input_* item types', () => {
    const sharedAdapterRoot = resolveChatlunaSiblingPackageRoot('shared-adapter');
    const sharedAdapterSource = readFileSync(join(sharedAdapterRoot, 'src', 'utils.ts'), 'utf8');
    const sharedAdapterRequesterSource = readFileSync(join(sharedAdapterRoot, 'src', 'requester.ts'), 'utf8');
    const sharedAdapterBundle = readFileSync(join(sharedAdapterRoot, 'lib', 'index.mjs'), 'utf8');

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
