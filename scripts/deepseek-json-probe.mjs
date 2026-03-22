#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import process from 'node:process';

function printUsage() {
  console.error(
    [
      'Usage: node scripts/deepseek-json-probe.mjs [options]',
      '',
      'Options:',
      '  --env-file <path>        Env file to load. Default: .env.local',
      '  --model <name>           Model name to request. Default: deepseek-chat',
      '  --system <text>          System prompt. Default: 只输出一个JSON对象，不要解释。',
      '  --user <text>            User prompt. Optional when --prompt-file or stdin is used.',
      '  --prompt-file <path>     Read user prompt from file.',
      '  --no-response-format     Do not send response_format=json_object.',
      '',
      'Examples:',
      '  node scripts/deepseek-json-probe.mjs --model deepseek-chat --user \'返回 {"ok":true}\'',
      '  printf \'返回 {"ok":true}\' | node scripts/deepseek-json-probe.mjs --model deepseek-chat',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const options = {
    envFile: '.env.local',
    model: 'deepseek-chat',
    system: '只输出一个JSON对象，不要解释。',
    user: '',
    promptFile: '',
    includeResponseFormat: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case '--env-file':
        options.envFile = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--model':
        options.model = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--system':
        options.system = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--user':
        options.user = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--prompt-file':
        options.promptFile = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--no-response-format':
        options.includeResponseFormat = false;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${value}`);
    }
  }

  if (!options.envFile.trim()) throw new Error('--env-file is required.');
  if (!options.model.trim()) throw new Error('--model is required.');
  return options;
}

function parseEnvText(content) {
  const env = {};
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (!key) continue;
    env[key] = rawValue.replace(/\$\{([^}]+)\}/gu, (_, variable) => env[variable] ?? process.env[variable] ?? '');
  }
  return env;
}

async function resolveUserPrompt(options) {
  if (options.promptFile) {
    return (await readFile(options.promptFile, 'utf8')).trim();
  }

  if (options.user.trim()) {
    return options.user.trim();
  }

  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    }
    return chunks.join('').trim();
  }

  throw new Error('User prompt is required. Use --user, --prompt-file, or stdin.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const env = parseEnvText(await readFile(options.envFile, 'utf8'));
  const baseUrl = (env.OPENAI_BASE_URL ?? '').trim().replace(/\/+$/u, '');
  const apiKey = (env.OPENAI_API_KEY ?? '').trim();
  if (!baseUrl) throw new Error(`OPENAI_BASE_URL is missing in ${options.envFile}.`);
  if (!apiKey) throw new Error(`OPENAI_API_KEY is missing in ${options.envFile}.`);

  const userPrompt = await resolveUserPrompt(options);
  const payload = {
    model: options.model.trim(),
    messages: [
      { role: 'system', content: options.system.trim() || '只输出一个JSON对象，不要解释。' },
      { role: 'user', content: userPrompt },
    ],
  };

  if (options.includeResponseFormat) {
    payload.response_format = { type: 'json_object' };
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const rawText = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.log(
      JSON.stringify(
        {
          envFile: options.envFile,
          requestedModel: payload.model,
          includeResponseFormat: options.includeResponseFormat,
          status: response.status,
          ok: response.ok,
          parseError: 'Response body is not valid JSON.',
          rawResponseText: rawText,
        },
        null,
        2,
      ),
    );
    return;
  }

  const choice = Array.isArray(parsed.choices) ? parsed.choices[0] ?? null : null;
  const content = choice?.message?.content ?? null;
  let contentIsValidJson = false;
  let contentJsonError = null;
  if (typeof content === 'string') {
    try {
      JSON.parse(content);
      contentIsValidJson = true;
    } catch (error) {
      contentJsonError = error instanceof Error ? error.message : String(error);
    }
  }

  console.log(
    JSON.stringify(
      {
        envFile: options.envFile,
        requestedModel: payload.model,
        includeResponseFormat: options.includeResponseFormat,
        status: response.status,
        ok: response.ok,
        returnedModel: parsed.model ?? null,
        finishReason: choice?.finish_reason ?? null,
        content,
        contentIsValidJson,
        contentJsonError,
        providerError: parsed.error ?? null,
        rawResponseText: rawText,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.stack ?? error.message : error));
  process.exitCode = 1;
});
