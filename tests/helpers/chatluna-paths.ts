import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function resolveInstalledCoreRoot(): string {
  const packageJsonPath = require.resolve('koishi-plugin-chatluna/package.json');
  return dirname(packageJsonPath);
}

function resolveLinkedCoreRoot(): string {
  return resolve(process.cwd(), '../chatluna/packages/core');
}

export function resolveChatlunaCoreRoot(): string {
  const linked = resolveLinkedCoreRoot();
  if (existsSync(join(linked, 'lib'))) {
    return linked;
  }

  return resolveInstalledCoreRoot();
}

export function resolveChatlunaSourceRoot(): string {
  const linked = resolveLinkedCoreRoot();
  if (existsSync(join(linked, 'src'))) {
    return linked;
  }

  return resolveInstalledCoreRoot();
}

export function resolveChatlunaSiblingPackageRoot(packageName: string): string {
  const sourceRoot = resolveChatlunaSourceRoot();
  const siblingFromInstalled = join(sourceRoot, '..', packageName);
  if (existsSync(siblingFromInstalled)) {
    return siblingFromInstalled;
  }

  return resolve(process.cwd(), `../chatluna/packages/${packageName}`);
}

export function resolveChatlunaCoreImportUrl(relativeLibPath: string): string {
  const coreRoot = resolveChatlunaCoreRoot();
  return pathToFileURL(join(coreRoot, relativeLibPath)).href;
}
