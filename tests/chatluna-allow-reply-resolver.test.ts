import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

const CHATLUNA_CORE_ROOT = resolve(process.cwd(), '../chatluna/packages/core');

describe('chatluna allow_reply resolver source and type export', () => {
  it('routes external allow checks through the chatluna service instead of a sibling event hook', () => {
    const content = readFileSync(`${CHATLUNA_CORE_ROOT}/src/middlewares/chat/allow_reply.ts`, 'utf8');

    expect(content).toContain('resolveAllowReply');
    expect(content).not.toContain('chatluna/before-allow-reply');
    expect(content).toContain('chatluna/before-check-sender');
  });

  it('declares the allow-reply resolver contract in the chat service source', () => {
    const content = readFileSync(`${CHATLUNA_CORE_ROOT}/src/services/chat.ts`, 'utf8');

    expect(content).toContain('registerAllowReplyResolver');
    expect(content).toContain('resolveAllowReply');
  });

  it('re-exports service type augmentations from the package root', () => {
    const content = readFileSync(`${CHATLUNA_CORE_ROOT}/lib/index.d.ts`, 'utf8');

    expect(content).toContain("import './services/types';");
  });

  it('build script discovers linked chatluna packages from qqbot package metadata', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/ensure-chatluna-build.sh'), 'utf8');

    expect(content).toContain("linked_prefix = 'link:../chatluna/packages/'");
    expect(content).toContain('workspace_packages');
    expect(content).toContain('visit(dep_dir)');
    expect(content).toContain('package_dir.name');
    expect(content).toContain('pnpm run fast-build "${BUILD_TARGETS[@]}"');
  });
});
