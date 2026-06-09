import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const PLUGINS_ROOT = resolve(process.cwd(), 'src/plugins');
const IMPORT_RE = /from ['"](\.{1,2}\/[^'"]+)['"]/g;

function walk(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === 'client' || entry === 'assets') continue;
      files.push(...walk(full));
      continue;
    }
    if (entry.endsWith('.ts')) files.push(full);
  }
  return files;
}

function pluginNamespace(filePath: string): string {
  const relative = posix.normalize(filePath.replace(`${PLUGINS_ROOT}/`, '').replace(/\\/g, '/'));
  const parts = relative.split('/');
  if (parts[0] === 'shared') return `shared/${parts[1] ?? ''}`;
  if (parts[0] === 'triggers') return `triggers/${parts[1] ?? ''}`;
  return parts[0] ?? '';
}

function resolveImportTarget(sourceFile: string, specifier: string): string {
  const base = resolve(sourceFile, '..');
  return normalize(resolve(base, specifier.replace(/\.js$/, '.ts')));
}

describe('plugin structure', () => {
  it('only allows cross-plugin imports through plugin index or shared modules', () => {
    const violations: string[] = [];
    for (const file of walk(PLUGINS_ROOT)) {
      const sourceNamespace = pluginNamespace(file);
      const content = readFileSync(file, 'utf8');
      for (const match of content.matchAll(IMPORT_RE)) {
        const specifier = match[1];
        const target = resolveImportTarget(file, specifier);
        if (!target.startsWith(PLUGINS_ROOT) || !target.endsWith('.ts')) continue;
        const targetNamespace = pluginNamespace(target);
        if (sourceNamespace === targetNamespace) continue;
        if (targetNamespace.startsWith('shared/')) continue;
        if (target.endsWith('/index.ts')) continue;
        violations.push(`${posix.normalize(file.replace(`${PLUGINS_ROOT}/`, '').replace(/\\/g, '/'))} -> ${specifier}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('does not reference removed legacy memory chain nodes', () => {
    const removedLegacyMemoryChainNode = ['qqbot', 'memory', 'v2'].join('_');
    const violations = walk(PLUGINS_ROOT)
      .map((file) => ({
        file,
        content: readFileSync(file, 'utf8'),
      }))
      .filter(({ content }) => content.includes(removedLegacyMemoryChainNode))
      .map(({ file }) => posix.normalize(file.replace(`${PLUGINS_ROOT}/`, '').replace(/\\/g, '/')));

    expect(violations).toEqual([]);
  });
});
