import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('qq voice config wiring', () => {
  it('loads the qq-voice plugin before group trigger and chatluna', () => {
    const content = readFileSync(resolve(process.cwd(), 'koishi.yml'), 'utf8');
    const voiceIndex = content.indexOf('./dist/plugins/reply:voice:');
    const triggerIndex = content.indexOf('./dist/plugins/triggers/group-natural:natural-trigger:');
    const chatlunaIndex = content.indexOf('chatluna:0qm1bk:');

    expect(voiceIndex).toBeGreaterThanOrEqual(0);
    expect(triggerIndex).toBeGreaterThan(voiceIndex);
    expect(chatlunaIndex).toBeGreaterThan(triggerIndex);

    expect(content).toContain("asrBaseUrl: ${{ env.QQ_VOICE_ASR_BASE_URL || '' }}");
    expect(content).toContain("ttsBaseUrl: ${{ env.QQ_VOICE_TTS_BASE_URL || '' }}");
    expect(content).toContain("maxJobsPerUser: ${{ +env.TASK_AUTOMATION_MAX_TASKS_PER_USER || 20 }}");
    expect(content).not.toContain('maxTasksPerUser:');
    expect(content).toContain("defaultModel: ${{ env.CHATLUNA_DEFAULT_MODEL || '' }}");
    expect(content).toContain("platform: ${{ env.CHATLUNA_PLATFORM || 'siliconflow' }}");
    expect(content).not.toContain('defaultModel: openai/gemini-3.1-pro-preview');
    expect(content).not.toContain('defaultModel: siliconflow/inclusionAI/Ring-flash-2.0');
  });

  it('declares loopback voice services and persisted voice data paths in compose', () => {
    const content = readFileSync(resolve(process.cwd(), 'compose.yaml'), 'utf8');

    expect(content).toContain('"${PMHQ_BIND_HOST:-127.0.0.1}:${PMHQ_PORT:-13000}:13000"');
    expect(content).toContain('"127.0.0.1:${LLONEBOT_WEBUI_PORT:-3080}:${LLONEBOT_WEBUI_PORT:-3080}"');
    expect(content).toContain('"127.0.0.1:${LLONEBOT_WS_PORT:-3001}:3001"');
    expect(content).toContain('pmhq_host: ${PMHQ_HOST:-pmhq}');
    expect(content).toContain('pmhq_port: ${PMHQ_PORT:-13000}');
    expect(content).toContain('aliases:');
    expect(content).toContain('- pmhq');
    expect(content).toContain('name: qqbot-stack_app_network');
    expect(content).toContain('LLONEBOT_WS_PORT: ${LLONEBOT_WS_PORT:-3001}');
    expect(content).toContain('ONEBOT_TOKEN: ${ONEBOT_TOKEN:-}');
    expect(content).toContain('docker.io/linyuchen/llbot}:${LLBOT_TAG:-7.11.0}');
    expect(content).toContain('"${LLONEBOT_DATA_DIR:-./.runtime/llonebot}:/app/llbot/data:Z"');
    expect(content).toContain('voice-asr:');
    expect(content).toContain('"127.0.0.1:${VOICE_ASR_PORT:-5161}:8080"');
    expect(content).toContain('./data/voice/asr:/data/voice/asr:Z');
    expect(content).toContain('./docker/llonebot-startup.sh:/startup.sh:Z');
    expect(content).toContain('command: ["/startup.sh"]');
    expect(content).not.toContain('voice-tts:');
    expect(content).not.toContain('"127.0.0.1:${VOICE_TTS_PORT:-5162}:8080"');
  });

  it('starts llonebot with explicit PMHQ host and port CLI args', () => {
    const content = readFileSync(resolve(process.cwd(), 'docker/llonebot-startup.sh'), 'utf8');

    expect(content).toContain('PMHQ_HOST="${pmhq_host:-${PMHQ_HOST:-pmhq}}"');
    expect(content).toContain('PMHQ_PORT="${pmhq_port:-${PMHQ_PORT:-13000}}"');
    expect(content).toContain("const dataDir = '/app/llbot/data'");
    expect(content).toContain("item.type === 'ws-reverse'");
    expect(content).toContain("item.url = ''");
    expect(content).toContain("/^config_\\d+\\.json$/");
    expect(content).toContain('writeManagedConfig(join(dataDir, name))');
    expect(content).toContain('"--pmhq-host=${PMHQ_HOST}"');
    expect(content).toContain('"--pmhq-port=${PMHQ_PORT}"');
  });

  it('documents local voice env vars in .env.example', () => {
    const content = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');

    expect(content).toContain('QQ_VOICE_ASR_BASE_URL=http://127.0.0.1:5161');
    expect(content).toContain('QQ_VOICE_TTS_BASE_URL=http://127.0.0.1:5162');
    expect(content).toContain('QQ_VOICE_OUTPUT_MAX_WORDS=80');
    expect(content).toContain('QQ_VOICE_OUTPUT_MAX_SECONDS=45');
    expect(content).toContain('QQ_VOICE_SYNTH_TIMEOUT_MS=300000');
    expect(content).toContain('CHATLUNA_ACTIVE_TAB=siliconflow');
    expect(content).toContain('CHATLUNA_PLATFORM=siliconflow');
    expect(content).toContain('CHATLUNA_OPENAI_BASE_URL=https://shell.wyzai.top/v1');
    expect(content).toContain('CHATLUNA_OPENAI_DEFAULT_MODEL=openai/gpt-5.4-medium-thinking');
    expect(content).toContain('CHATLUNA_COPILOT_BASE_URL=http://127.0.0.1:5140/api/internal/copilot/v1');
    expect(content).toContain('CHATLUNA_COPILOT_DEFAULT_MODEL=gpt-5.4-mini');
    expect(content).toContain('CHATLUNA_COPILOT_OAUTH_CLIENT_ID=Iv1.b507a08c87ecfe98');
    expect(content).toContain('TASK_AUTOMATION_POLL_MS=30000');
    expect(content).toContain('TASK_AUTOMATION_MAX_TASKS_PER_USER=20');
    expect(content).not.toContain('CHAT_ENABLED_GROUPS=');
    expect(content).not.toContain('TASK_AUTOMATION_INTENT_ENABLED=');
    expect(content).not.toContain('TASK_AUTOMATION_DELIVERY_MODEL=');
    expect(content).not.toContain('TASK_AUTOMATION_CHAT_REPLY_MODEL=');
    expect(content).toContain('PMHQ_BIND_HOST=127.0.0.1');
    expect(content).toContain('LLONEBOT_DATA_DIR=./.runtime/llonebot');
    expect(content).not.toContain('VOICE_TTS_GPT_WEIGHTS=/data/voice/tts/models/sakiko_v2pp-e15.ckpt');
    expect(content).not.toContain('VOICE_TTS_REF_BLACK=/data/voice/tts/references/black_sakiko.wav');
  });

  it('ships a server env template with voice disabled', () => {
    const content = readFileSync(resolve(process.cwd(), '.env.server.example'), 'utf8');

    expect(content).toContain('QQ_VOICE_INPUT_ENABLED=false');
    expect(content).toContain('QQ_VOICE_OUTPUT_ENABLED=false');
    expect(content).toContain('QQ_VOICE_ASR_BASE_URL=');
    expect(content).toContain('QQ_VOICE_TTS_BASE_URL=');
    expect(content).toContain('CHATLUNA_ACTIVE_TAB=siliconflow');
    expect(content).toContain('CHATLUNA_OPENAI_BASE_URL=https://shell.wyzai.top/v1');
    expect(content).toContain('CHATLUNA_COPILOT_BASE_URL=http://127.0.0.1:5140/api/internal/copilot/v1');
    expect(content).toContain('TASK_AUTOMATION_POLL_MS=30000');
    expect(content).toContain('TASK_AUTOMATION_MAX_TASKS_PER_USER=20');
    expect(content).not.toContain('CHAT_ENABLED_GROUPS=');
    expect(content).not.toContain('TASK_AUTOMATION_INTENT_ENABLED=');
    expect(content).not.toContain('TASK_AUTOMATION_DELIVERY_MODEL=');
    expect(content).not.toContain('TASK_AUTOMATION_CHAT_REPLY_MODEL=');
    expect(content).toContain('PMHQ_BIND_HOST=127.0.0.1');
    expect(content).toContain('Set AUTO_LOGIN_QQ only if this server should use QQ quick-login by default.');
    expect(content).toContain('only one side should keep AUTO_LOGIN_QQ enabled');
    expect(content).toContain('LLONEBOT_DATA_DIR=/opt/qqbot/shared/llonebot');
    expect(content).toContain('llonebot must still resolve pmhq on');
    expect(content).not.toContain('host.containers.internal');
    expect(content).toContain('# Server deploy does not run voice-asr.');
  });

  it('ships a laptop-local TTS env template and user service example', () => {
    const envTemplate = readFileSync(resolve(process.cwd(), 'config/voice-tts.local.example'), 'utf8');
    const serviceTemplate = readFileSync(
      resolve(process.cwd(), 'config/systemd/qqbot-voice-tts.service.example'),
      'utf8',
    );

    expect(envTemplate).toContain('VOICE_TTS_HOST=127.0.0.1');
    expect(envTemplate).toContain('VOICE_TTS_DEVICE=cuda');
    expect(envTemplate).toContain('VOICE_TTS_UPSTREAM_ROOT=/home/kkkzbh/code/qqbot/.runtime/gpt-sovits-upstream');
    expect(envTemplate).toContain(
      'VOICE_TTS_GPT_WEIGHTS=/home/kkkzbh/code/qqbot/data/voice/tts-local/models/sakiko_v2pp-e15.ckpt',
    );
    expect(envTemplate).toContain(
      'VOICE_TTS_REF_BLACK=/home/kkkzbh/code/qqbot/data/voice/tts-local/references/black_sakiko.wav',
    );
    expect(envTemplate).toContain('VOICE_TTS_MAX_TEXT_CHARS=200');
    expect(envTemplate).toContain('VOICE_TTS_PROMPT_LANG=all_ja');
    expect(envTemplate).toContain('VOICE_TTS_TEXT_LANG=all_zh');
    expect(serviceTemplate).toContain(
      'Environment=QQBOT_VOICE_TTS_ENV_FILE=/home/kkkzbh/code/qqbot/config/voice-tts.local.env',
    );
    expect(serviceTemplate).toContain('ExecStart=/home/kkkzbh/code/qqbot/scripts/run-voice-tts-local.sh');
    expect(serviceTemplate).not.toContain('tailscaled.service');
  });

  it('ships a dedicated tailnet publisher template instead of rebinding the model process', () => {
    const envTemplate = readFileSync(resolve(process.cwd(), 'config/voice-tts.tailnet.example'), 'utf8');
    const serviceTemplate = readFileSync(
      resolve(process.cwd(), 'config/systemd/qqbot-voice-tts-tailnet.service.example'),
      'utf8',
    );

    expect(envTemplate).toContain('VOICE_TTS_TAILNET_PORT=5162');
    expect(envTemplate).toContain('VOICE_TTS_LOCAL_UPSTREAM_HOST=127.0.0.1');
    expect(serviceTemplate).toContain('qqbot-voice-tts.service');
    expect(serviceTemplate).toContain('QQBOT_VOICE_TTS_TAILNET_ENV_FILE=/home/kkkzbh/code/qqbot/config/voice-tts.tailnet.env');
    expect(serviceTemplate).toContain('ExecStart=/home/kkkzbh/code/qqbot/scripts/publish-voice-tts-tailnet.sh apply');
    expect(serviceTemplate).toContain('ExecStop=/home/kkkzbh/code/qqbot/scripts/publish-voice-tts-tailnet.sh clear');
  });

  it('keeps the sakiko preset free of runtime transport protocol text and deprecated tag contracts', () => {
    const content = readFileSync(resolve(process.cwd(), 'data/chathub/presets/sakiko.yml'), 'utf8');

    expect(content).not.toContain('# 回复组织原则');
    expect(content).not.toContain('你的最终回复只输出一个合法的 ReplyPlan JSON 对象本身');
    expect(content).not.toContain('普通聊天也要写成 ReplyPlan');
    expect(content).not.toContain('voice.content 只写你要说的话');
    expect(content).not.toContain('<qqbot-multiline>');
    expect(content).not.toContain('<qqbot-voice>');
  });

  it('deploys a server stack without voice-asr and keeps koishi voice settings sourced from .env.server', () => {
    const content = readFileSync(resolve(process.cwd(), '.github/workflows/deploy.yml'), 'utf8');

    expect(content).toContain('PODMAN_COMPOSE_BIN="$(command -v podman-compose)"');
    expect(content).toContain('PODMAN_NETWORK_NAME="qqbot-stack_app_network"');
    expect(content).toContain('podman rm -f qqbot-voice-asr >/dev/null 2>&1 || true');
    expect(content).toContain('retry_cmd() {');
    expect(content).toContain('ConnectTimeout=30');
    expect(content).toContain('ConnectionAttempts=5');
    expect(content).toContain('KillMode=none');
    expect(content).toContain('EnvironmentFile=${APP_DIR}/.env.server');
    expect(content).toContain('EnvironmentFile=-${SHARED_DIR}/.env.runtime');
    expect(content).toContain('DEPLOY_SHARED_DIR');
    expect(content).toContain("QQBOT_SHARED_DIR='${DEPLOY_SHARED_DIR}' bash '${DEPLOY_APP_DIR}/scripts/prepare-server-runtime-layer.sh'");
    expect(content).toContain('Environment=QQBOT_ENV_BASE_FILE=${APP_DIR}/.env.server');
    expect(content).toContain('Environment=QQBOT_ENV_OVERRIDE_FILE=${SHARED_DIR}/.env.runtime');
    expect(content).toContain('Environment=QQBOT_PODMAN_COMPOSE_BIN=${PODMAN_COMPOSE_BIN}');
    expect(content).toContain('Environment=QQBOT_PODMAN_NETWORK_NAME=${PODMAN_NETWORK_NAME}');
    expect(content).toContain('Environment=CHATLUNA_PRESET_DIRS=${SHARED_DIR}/presets:${APP_DIR}/data/chathub/presets');
    expect(content).toContain('Environment=CHATLUNA_RUNTIME_PRESET_DIR=${SHARED_DIR}/presets');
    expect(content).toContain("./scripts/podman-stack-up.sh pmhq llbot && ./scripts/verify-pmhq-network.sh");
    expect(content).toContain('ExecStop=${PODMAN_COMPOSE_BIN} -f ${APP_DIR}/compose.yaml stop pmhq llbot');
    expect(content).toContain('bash "${APP_DIR}/scripts/verify-pmhq-network.sh"');
    expect(content).toContain("--exclude='.env.local'");
    expect(content).toContain("--exclude='.env.server'");
    expect(content).toContain("cat > '${DEPLOY_APP_DIR}/.env.server'");
    expect(content).toContain('node ./scripts/validate-server-voice-env.mjs "${VALIDATE_ENV_FILE}"');
    expect(content).toContain('EnvironmentFile=${APP_DIR}/.env.server');
    expect(content).toContain('exec pnpm exec koishi start koishi.yml');
    expect(content).not.toContain('export QQBOT_ENV_FILE=${APP_DIR}/.env.server');
    expect(content).toContain('cd "${CHATLUNA_DIR}"');
    expect(content).toContain('mkdir -p "${CHATLUNA_DIR}/.yarn-cache"');
    expect(content).toContain('YARN_CACHE_FOLDER="${CHATLUNA_DIR}/.yarn-cache"');
    expect(content).toContain('corepack yarn install --frozen-lockfile');
    expect(content).not.toContain('rm -rf node_modules');
    expect(content).toContain('command -v google-chrome >/dev/null 2>&1');
    expect(content).toContain('google-chrome-stable_current_amd64.deb');
    expect(content).toContain('apt-get purge -y chromium-browser >/dev/null 2>&1 || true');
    expect(content).toContain('snap remove --purge chromium >/dev/null 2>&1 || true');
    expect(content).not.toContain('apt-get install -y chromium-browser');
    expect(content).not.toContain('apt-get install -y chromium');
    expect(content).not.toContain('pnpm install --no-frozen-lockfile');
    expect(content).not.toContain('up -d --build --force-recreate');
  });

  it('ships a dedicated Podman stack reset script for pmhq and llbot', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/podman-stack-up.sh'), 'utf8');

    expect(content).toContain('NETWORK_NAME="${QQBOT_PODMAN_NETWORK_NAME:-qqbot-stack_app_network}"');
    expect(content).toContain('LLONEBOT_DATA_DIR="${LLONEBOT_DATA_DIR:-${ROOT_DIR}/.runtime/llonebot}"');
    expect(content).toContain('LEGACY_LLBOT_DATA_DIR="${ROOT_DIR}/data/llonebot"');
    expect(content).toContain('prepare_llonebot_data_dir');
    expect(content).toContain('Seeding llonebot runtime data from ${LEGACY_LLBOT_DATA_DIR} to ${LLONEBOT_DATA_DIR}');
    expect(content).toContain('compose down --remove-orphans || true');
    expect(content).toContain('podman network rm -f "${NETWORK_NAME}" >/dev/null');
    expect(content).toContain('podman network create "${NETWORK_NAME}" >/dev/null');
    expect(content).toContain('compose up -d "${SERVICES[@]}"');
    expect(content).toContain('sed -i \'s/"cniVersion": "1.0.0"/"cniVersion": "0.4.0"/\' "${config_path}"');
  });

  it('ships a deployment verifier that rejects broken llonebot runtime wiring', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/verify-pmhq-network.sh'), 'utf8');

    expect(content).toContain('NETWORK_NAME="${QQBOT_PODMAN_NETWORK_NAME:-qqbot-stack_app_network}"');
    expect(content).toContain('wait_until "${PMHQ_CONTAINER} joined ${NETWORK_NAME}"');
    expect(content).toContain('wait_until "${LLBOT_CONTAINER} joined ${NETWORK_NAME}"');
    expect(content).toContain('wait_until "${LLBOT_CONTAINER} serves WebUI on ${LLBOT_WEBUI_PORT}"');
    expect(content).toContain('wait_until "${LLBOT_CONTAINER} completes PMHQ WebSocket handshake"');
    expect(content).toContain('== podman inspect network info ==');
    expect(content).toContain('== llonebot /etc/hosts ==');
    expect(content).toContain('host 127.0.0.1:${LLBOT_WEBUI_PORT}');
    expect(content).toContain('== llonebot webui probe ==');
    expect(content).toContain('llbot_http_probe');
    expect(content).toContain('== llonebot websocket status ==');
  });

  it('ships a one-shot server login recovery helper instead of disabling auto login permanently', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/server-recover-qq-login.sh'), 'utf8');

    expect(content).toContain('Usage: $0 prepare|restore');
    expect(content).toContain('AUTO_LOGIN_QQ_ORIG=');
    expect(content).toContain('systemctl --user stop qqbot.target');
    expect(content).toContain('./scripts/podman-stack-up.sh pmhq llbot');
    expect(content).toContain('./scripts/verify-pmhq-network.sh');
    expect(content).toContain('AUTO_LOGIN_QQ is temporarily cleared for this stack run only.');
    expect(content).toContain('systemctl --user restart qqbot.target');
    expect(content).toContain('AUTO_LOGIN_QQ="${AUTO_LOGIN_QQ_ORIG:-${AUTO_LOGIN_QQ:-}}"');
  });

  it('ships a runtime layer migration script that seeds env and presets into the shared dir', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/prepare-server-runtime-layer.sh'), 'utf8');

    expect(content).toContain('RUNTIME_ENV_FILE="${SHARED_DIR}/.env.runtime"');
    expect(content).toContain('RUNTIME_PRESET_DIR="${SHARED_DIR}/presets"');
    expect(content).toContain('RUNTIME_LLBOT_DIR="${SHARED_DIR}/llonebot"');
    expect(content).toContain('LEGACY_LLBOT_DIR="${APP_DIR}/data/llonebot"');
    expect(content).toContain('SEED_MARKER_FILE="${SHARED_DIR}/.runtime-layer.seeded"');
    expect(content).toContain('cp -a "${LEGACY_LLBOT_DIR}/." "${RUNTIME_LLBOT_DIR}/"');
    expect(content).toContain("keyMatches = [...sourceText.matchAll(/key:\\s*'([^']+)'/g)]");
    expect(content).toContain("find \"${BUNDLED_PRESET_DIR}\" -maxdepth 1 -type f");
    expect(content).toContain("touch \"${SEED_MARKER_FILE}\"");
  });

  it('ships a server voice env validator that rejects empty or loopback TTS settings', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/validate-server-voice-env.mjs'), 'utf8');

    expect(content).toContain("QQ_VOICE_OUTPUT_ENABLED=true but QQ_VOICE_TTS_BASE_URL is empty.");
    expect(content).toContain("QQ_VOICE_OUTPUT_ENABLED=true but QQ_VOICE_TTS_API_KEY is empty.");
    expect(content).toContain('server QQ_VOICE_TTS_BASE_URL must point to laptop Tailnet TTS, not 127.0.0.1/localhost.');
    expect(content).toContain('server deploy does not support QQ_VOICE_INPUT_ENABLED=true.');
  });

  it('lets stickers sync resolve local env first and server env second', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/stickers-sync.mjs'), 'utf8');

    expect(content).toContain("path.resolve(ROOT_DIR, '.env.local')");
    expect(content).toContain("path.resolve(ROOT_DIR, '.env.server')");
    expect(content).not.toContain("path.resolve(ROOT_DIR, '.env')");
  });
});
