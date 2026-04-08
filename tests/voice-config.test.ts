import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('qq voice config wiring', () => {
  it('loads the qq-voice plugin before group trigger and chatluna', () => {
    const content = readFileSync(resolve(process.cwd(), 'koishi.yml'), 'utf8');
    const voiceIndex = content.indexOf('./dist/plugins/reply:voice:');
    const triggerIndex = content.indexOf('./dist/plugins/triggers/group-natural:natural-trigger:');
    const chatlunaIndex = content.indexOf('chatluna:0qm1bk:');
    const agentIndex = content.indexOf('chatluna-agent:computer-agent:');
    const commonIndex = content.indexOf('chatluna-plugin-common:qf1a6x:');

    expect(voiceIndex).toBeGreaterThanOrEqual(0);
    expect(triggerIndex).toBeGreaterThan(voiceIndex);
    expect(chatlunaIndex).toBeGreaterThan(triggerIndex);
    expect(commonIndex).toBeGreaterThan(chatlunaIndex);
    expect(agentIndex).toBeGreaterThan(commonIndex);

    expect(content).toContain("asrBaseUrl: ${{ env.QQ_VOICE_ASR_BASE_URL || '' }}");
    expect(content).toContain("ttsBaseUrl: ${{ env.QQ_VOICE_TTS_BASE_URL || '' }}");
    expect(content).toContain("maxJobsPerUser: ${{ +env.TASK_AUTOMATION_MAX_TASKS_PER_USER || 20 }}");
    expect(content).not.toContain('maxTasksPerUser:');
    expect(content).toContain("platform: ${{ env.CHATLUNA_PLATFORM || 'siliconflow' }}");
    expect(content).toContain("maxContextRatio: ${{ +env.CHATLUNA_MAX_CONTEXT_RATIO || 0.35 }}");
    expect(content).toContain('chatluna-agent:computer-agent: {}');
  });

  it('keeps compose focused on pmhq and voice-asr only', () => {
    const content = readFileSync(resolve(process.cwd(), 'compose.yaml'), 'utf8');

    expect(content).toContain('"${PMHQ_BIND_HOST:-127.0.0.1}:${PMHQ_PORT:-13000}:13000"');
    expect(content).toContain('voice-asr:');
    expect(content).toContain('"127.0.0.1:${VOICE_ASR_PORT:-5161}:8080"');
    expect(content).toContain('./data/voice/asr:/data/voice/asr:Z');
    expect(content).not.toContain('\n  llbot:\n');
    expect(content).not.toContain('qqbot-stack_app_network');
    expect(content).not.toContain('pmhq_host:');
    expect(content).not.toContain('LLBOT_IMAGE');
    expect(content).not.toContain('LLBOT_TAG');
    expect(content).not.toContain('command: ["/startup.sh"]');
  });

  it('documents local host-llbot env vars in .env.example', () => {
    const content = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');

    expect(content).toContain('QQ_VOICE_ASR_BASE_URL=http://127.0.0.1:5161');
    expect(content).toContain('QQ_VOICE_TTS_BASE_URL=http://127.0.0.1:5162');
    expect(content).toContain('PMHQ_BIND_HOST=127.0.0.1');
    expect(content).toContain('PMHQ_PORT=13000');
    expect(content).toContain('LLBOT_VERSION=7.11.0');
    expect(content).toContain('LLBOT_RUNTIME_DIR=./.runtime/llbot');
    expect(content).toContain('LLONEBOT_DATA_DIR=./.runtime/llonebot');
    expect(content).not.toContain('LLBOT_IMAGE=');
    expect(content).not.toContain('LLBOT_TAG=');
    expect(content).not.toContain('PMHQ_HOST=');
  });

  it('ships a server env template with host llbot defaults', () => {
    const content = readFileSync(resolve(process.cwd(), '.env.server.example'), 'utf8');

    expect(content).toContain('QQ_VOICE_INPUT_ENABLED=false');
    expect(content).toContain('QQ_VOICE_OUTPUT_ENABLED=false');
    expect(content).toContain('PMHQ_BIND_HOST=127.0.0.1');
    expect(content).toContain('PMHQ_PORT=13000');
    expect(content).toContain('LLBOT_VERSION=7.11.0');
    expect(content).toContain('LLBOT_RUNTIME_DIR=/opt/qqbot/shared/llbot-runtime');
    expect(content).toContain('LLONEBOT_DATA_DIR=/opt/qqbot/shared/llonebot');
    expect(content).toContain('Set AUTO_LOGIN_QQ only if this server should use QQ quick-login by default.');
    expect(content).not.toContain('LLBOT_IMAGE=');
    expect(content).not.toContain('LLBOT_TAG=');
    expect(content).not.toContain('PMHQ_HOST=');
    expect(content).not.toContain('pmhq:13000');
  });

  it('ships local systemd templates for pmhq, llbot and koishi', () => {
    const pmhqService = readFileSync(
      resolve(process.cwd(), 'config/systemd/qqbot-pmhq.service.example'),
      'utf8',
    );
    const llbotService = readFileSync(
      resolve(process.cwd(), 'config/systemd/qqbot-llbot.service.example'),
      'utf8',
    );
    const koishiService = readFileSync(
      resolve(process.cwd(), 'config/systemd/qqbot-koishi.service.example'),
      'utf8',
    );

    expect(pmhqService).toContain('ExecStart=/home/kkkzbh/code/qqbot/scripts/podman-pmhq-service.sh up');
    expect(pmhqService).toContain('ExecStop=/home/kkkzbh/code/qqbot/scripts/podman-pmhq-service.sh stop');
    expect(llbotService).toContain('ExecStart=/home/kkkzbh/code/qqbot/scripts/run-llbot-host.sh');
    expect(llbotService).toContain('After=network-online.target qqbot-pmhq.service');
    expect(koishiService).toContain('After=network-online.target qqbot-llbot.service');
    expect(koishiService).toContain('Wants=network-online.target qqbot-llbot.service');
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

  it('deploys server units for pmhq, llbot and koishi with layered envs', () => {
    const content = readFileSync(resolve(process.cwd(), '.github/workflows/deploy.yml'), 'utf8');

    expect(content).toContain('PODMAN_COMPOSE_BIN="$(command -v podman-compose)"');
    expect(content).toContain('podman rm -f qqbot-voice-asr >/dev/null 2>&1 || true');
    expect(content).toContain('retry_cmd() {');
    expect(content).toContain('ConnectTimeout=30');
    expect(content).toContain('ConnectionAttempts=5');
    expect(content).toContain('EnvironmentFile=${APP_DIR}/.env.server');
    expect(content).toContain('EnvironmentFile=-${SHARED_DIR}/.env.runtime');
    expect(content).toContain('DEPLOY_SHARED_DIR');
    expect(content).toContain("QQBOT_SHARED_DIR='${DEPLOY_SHARED_DIR}' bash '${DEPLOY_APP_DIR}/scripts/prepare-server-runtime-layer.sh'");
    expect(content).toContain('Environment=QQBOT_ENV_BASE_FILE=${APP_DIR}/.env.server');
    expect(content).toContain('Environment=QQBOT_ENV_OVERRIDE_FILE=${SHARED_DIR}/.env.runtime');
    expect(content).toContain('Environment=QQBOT_PODMAN_COMPOSE_BIN=${PODMAN_COMPOSE_BIN}');
    expect(content).toContain('Environment=CHATLUNA_PRESET_DIRS=${SHARED_DIR}/presets:${APP_DIR}/data/chathub/presets');
    expect(content).toContain('Environment=CHATLUNA_RUNTIME_PRESET_DIR=${SHARED_DIR}/presets');
    expect(content).toContain('cat > "${USER_SYSTEMD_DIR}/qqbot-pmhq.service"');
    expect(content).toContain('cat > "${USER_SYSTEMD_DIR}/qqbot-llbot.service"');
    expect(content).toContain('cat > "${USER_SYSTEMD_DIR}/qqbot-koishi.service"');
    expect(content).toContain("./scripts/podman-pmhq-service.sh up");
    expect(content).toContain("./scripts/run-llbot-host.sh");
    expect(content).toContain('After=network-online.target qqbot-llbot.service');
    expect(content).toContain('Wants=qqbot-pmhq.service qqbot-llbot.service qqbot-koishi.service');
    expect(content).toContain('bash "${APP_DIR}/scripts/verify-qqbot-host-runtime.sh"');
    expect(content).not.toContain('qqbot-stack.service');
    expect(content).not.toContain('verify-pmhq-network.sh');
    expect(content).not.toContain('podman-stack-up.sh');
  });

  it('ships a dedicated pmhq compose helper for the host topology', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/podman-pmhq-service.sh'), 'utf8');

    expect(content).toContain('Usage: $0 up|stop|restart');
    expect(content).toContain('compose up -d pmhq');
    expect(content).toContain('compose stop pmhq');
    expect(content).toContain('remove_legacy_llbot_container');
    expect(content).not.toContain('compose up -d llbot');
  });

  it('ships a host runtime verifier for pmhq, llbot and koishi wiring', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/verify-qqbot-host-runtime.sh'), 'utf8');

    expect(content).toContain('wait_until "${PMHQ_CONTAINER} is running"');
    expect(content).toContain('wait_until "pmhq health endpoint is reachable"');
    expect(content).toContain('wait_until "llbot webui is reachable"');
    expect(content).toContain('wait_until "${LLBOT_UNIT} completes PMHQ WebSocket handshake"');
    expect(content).toContain('wait_until "koishi can reach llbot websocket"');
    expect(content).toContain('journalctl --user -u "${LLBOT_UNIT}"');
    expect(content).toContain('new WebSocket(process.argv[1])');
  });

  it('ships a one-shot server login recovery helper for pmhq and llbot services', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/server-recover-qq-login.sh'), 'utf8');

    expect(content).toContain('Usage: $0 prepare|restore');
    expect(content).toContain('AUTO_LOGIN_QQ_ORIG=');
    expect(content).toContain('systemctl --user stop qqbot.target');
    expect(content).toContain('systemctl --user start qqbot-pmhq.service');
    expect(content).toContain('systemctl --user start qqbot-llbot.service');
    expect(content).toContain('${ROOT_DIR}/scripts/verify-qqbot-host-runtime.sh');
    expect(content).toContain('AUTO_LOGIN_QQ is temporarily cleared in ${ENV_FILE}.');
    expect(content).toContain('systemctl --user restart qqbot.target');
    expect(content).toContain('set_auto_login_value');
  });

  it('ships a runtime layer migration script that seeds env, presets and llbot dirs into the shared dir', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/prepare-server-runtime-layer.sh'), 'utf8');

    expect(content).toContain('RUNTIME_ENV_FILE="${SHARED_DIR}/.env.runtime"');
    expect(content).toContain('RUNTIME_PRESET_DIR="${SHARED_DIR}/presets"');
    expect(content).toContain('RUNTIME_LLBOT_DIR="${SHARED_DIR}/llonebot"');
    expect(content).toContain('RUNTIME_LLBOT_RUNTIME_DIR="${SHARED_DIR}/llbot-runtime"');
    expect(content).toContain('LEGACY_LLBOT_DIR="${APP_DIR}/data/llonebot"');
    expect(content).toContain('SEED_MARKER_FILE="${SHARED_DIR}/.runtime-layer.seeded"');
    expect(content).toContain('cp -a "${LEGACY_LLBOT_DIR}/." "${RUNTIME_LLBOT_DIR}/"');
    expect(content).toContain("keyMatches = [...sourceText.matchAll(/key:\\s*'([^']+)'/g)]");
    expect(content).toContain("find \"${BUNDLED_PRESET_DIR}\" -maxdepth 1 -type f");
    expect(content).toContain('mkdir -p "${SHARED_DIR}" "${RUNTIME_PRESET_DIR}" "${RUNTIME_LLBOT_DIR}" "${RUNTIME_LLBOT_RUNTIME_DIR}"');
    expect(content).toContain('upsert_env_value "LLONEBOT_DATA_DIR" "${RUNTIME_LLBOT_DIR}"');
    expect(content).toContain('upsert_env_value "LLBOT_RUNTIME_DIR" "${RUNTIME_LLBOT_RUNTIME_DIR}"');
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
