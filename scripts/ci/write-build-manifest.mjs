#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const directIndex = process.argv.indexOf(`--${name}`);
  if (directIndex >= 0) {
    return process.argv[directIndex + 1] ?? fallback;
  }
  const matched = process.argv.find((arg) => arg.startsWith(prefix));
  return matched ? matched.slice(prefix.length) : fallback;
}

function commandOutput(command, args, fallback = '') {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

function envValue(name, fallback = '') {
  const value = process.env[name];
  return value == null || value === '' ? fallback : value;
}

const outputPath = resolve(readArg('output', 'artifacts/build-manifest.json'));
const createdAt = new Date().toISOString();
const qqbotSha = envValue('QQBOT_SHA', commandOutput('git', ['rev-parse', 'HEAD']));
const chatlunaSourceDir = envValue('CHATLUNA_SOURCE_DIR', 'chatluna-src');
const chatlunaSha = envValue('CHATLUNA_SHA', commandOutput('git', ['-C', chatlunaSourceDir, 'rev-parse', 'HEAD']));

const manifest = {
  schemaVersion: 1,
  artifact: {
    createdAt,
  },
  qqbot: {
    repository: envValue('QQBOT_REPOSITORY', envValue('GITHUB_REPOSITORY')),
    ref: envValue('QQBOT_REF', envValue('GITHUB_REF')),
    sha: qqbotSha,
  },
  chatluna: {
    repository: envValue('CHATLUNA_REPOSITORY', 'kkkzbh/chatluna'),
    ref: envValue('CHATLUNA_REF', 'v1-dev'),
    sha: chatlunaSha,
  },
  tools: {
    node: commandOutput('node', ['--version']),
    pnpm: commandOutput('pnpm', ['--version']),
    yarn: envValue(
      'YARN_VERSION',
      commandOutput('corepack', ['yarn@1.22.22', '--version'], commandOutput('yarn', ['--version'], '1.22.22')),
    ),
  },
  github: {
    workflow: envValue('GITHUB_WORKFLOW'),
    runId: envValue('GITHUB_RUN_ID'),
    runAttempt: envValue('GITHUB_RUN_ATTEMPT'),
    actor: envValue('GITHUB_ACTOR'),
    serverUrl: envValue('GITHUB_SERVER_URL', 'https://github.com'),
    repository: envValue('GITHUB_REPOSITORY'),
    ref: envValue('GITHUB_REF'),
    sha: envValue('GITHUB_SHA'),
  },
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(outputPath);
