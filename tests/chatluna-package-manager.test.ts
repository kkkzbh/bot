import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helperPath = resolve(process.cwd(), 'scripts/lib/chatluna-package-manager.sh');
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-chatluna-package-manager-'));
  tempDirs.push(dir);
  return dir;
}

function writePackageJson(root: string, packageJson: Record<string, unknown>): void {
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(packageJson)}\n`, 'utf8');
}

function createCorepackStub(root: string): { binDir: string; capturePath: string } {
  const binDir = join(root, 'bin');
  const capturePath = join(root, 'corepack-args.txt');
  mkdirSync(binDir, { recursive: true });
  const corepackPath = join(binDir, 'corepack');
  writeFileSync(
    corepackPath,
    ['#!/usr/bin/env bash', 'printf "%s\\n" "$@" > "$COREPACK_CAPTURE"', ''].join('\n'),
    'utf8',
  );
  chmodSync(corepackPath, 0o755);
  return { binDir, capturePath };
}

function runHelper(command: string, env: Record<string, string>): string {
  return execFileSync('bash', ['-lc', `source "$HELPER_PATH"; ${command}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HELPER_PATH: helperPath,
      ...env,
    },
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('chatluna package manager helper', () => {
  it('uses the explicit CI Yarn version for ChatLuna checkouts without packageManager', () => {
    const root = createTempDir();
    writePackageJson(root, { name: '@root/chatluna-koishi' });
    const { binDir, capturePath } = createCorepackStub(root);

    runHelper('chatluna_yarn_install "$CHATLUNA_ROOT"', {
      CHATLUNA_ROOT: root,
      CHATLUNA_YARN_VERSION: '1.22.22',
      COREPACK_CAPTURE: capturePath,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    });

    expect(readFileSync(capturePath, 'utf8').trim().split('\n')).toEqual([
      'yarn@1.22.22',
      'install',
      '--frozen-lockfile',
    ]);
  });

  it('prefers the linked ChatLuna packageManager over the explicit CI Yarn version', () => {
    const root = createTempDir();
    writePackageJson(root, {
      name: '@root/chatluna-koishi',
      packageManager: 'yarn@4.14.1',
    });
    const { binDir, capturePath } = createCorepackStub(root);

    runHelper('chatluna_yarn_install_immutable "$CHATLUNA_ROOT"', {
      CHATLUNA_ROOT: root,
      CHATLUNA_YARN_VERSION: '1.22.22',
      COREPACK_CAPTURE: capturePath,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    });

    expect(readFileSync(capturePath, 'utf8').trim().split('\n')).toEqual([
      'yarn@4.14.1',
      'install',
      '--immutable',
    ]);
  });

  it('fails when ChatLuna declares no packageManager and no explicit Yarn version is provided', () => {
    const root = createTempDir();
    writePackageJson(root, { name: '@root/chatluna-koishi' });

    const result = spawnSync('bash', ['-lc', 'source "$HELPER_PATH"; chatluna_package_manager "$CHATLUNA_ROOT"'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HELPER_PATH: helperPath,
        CHATLUNA_ROOT: root,
        CHATLUNA_YARN_VERSION: '',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('set CHATLUNA_YARN_VERSION explicitly');
  });
});
