import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chatluna build script dependency closure', () => {
  it('builds local workspace peer dependencies before dependent linked packages', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/ensure-chatluna-build.sh'), 'utf8');

    expect(content).toContain('local_dependency_names = [');
    expect(content).toContain("*package_data.get('dependencies', {}),");
    expect(content).toContain("*package_data.get('peerDependencies', {}),");
    expect(content).toContain('visit(dep_dir)');
  });
});
