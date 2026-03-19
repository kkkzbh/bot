import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceDir = resolve(root, 'src/plugins/bot-console/client');
const targetDirs = [
  resolve(root, 'dist/plugins/bot-console/client'),
  resolve(root, 'node_modules/.cache/qqbot-bot-console'),
];

for (const targetDir of targetDirs) {
  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });
}
