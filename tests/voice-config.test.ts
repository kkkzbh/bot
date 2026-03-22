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

    expect(content).toContain("enabled: ${{ env.QQ_VOICE_ENABLED !== 'false' }}");
    expect(content).toContain("asrBaseUrl: ${{ env.QQ_VOICE_ASR_BASE_URL || 'http://127.0.0.1:5161' }}");
    expect(content).toContain("ttsBaseUrl: ${{ env.QQ_VOICE_TTS_BASE_URL || 'http://127.0.0.1:5162' }}");
  });

  it('declares loopback voice services and persisted voice data paths in compose', () => {
    const content = readFileSync(resolve(process.cwd(), 'compose.yaml'), 'utf8');

    expect(content).toContain('voice-asr:');
    expect(content).toContain('"127.0.0.1:${VOICE_ASR_PORT:-5161}:8080"');
    expect(content).toContain('./data/voice/asr:/data/voice/asr:Z');
    expect(content).not.toContain('voice-tts:');
    expect(content).not.toContain('"127.0.0.1:${VOICE_TTS_PORT:-5162}:8080"');
  });

  it('documents local voice env vars in .env.example', () => {
    const content = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');

    expect(content).toContain('QQ_VOICE_ENABLED=true');
    expect(content).toContain('QQ_VOICE_ASR_BASE_URL=http://127.0.0.1:5161');
    expect(content).toContain('QQ_VOICE_TTS_BASE_URL=http://127.0.0.1:5162');
    expect(content).toContain('QQ_VOICE_OUTPUT_MAX_WORDS=80');
    expect(content).toContain('QQ_VOICE_OUTPUT_MAX_SECONDS=45');
    expect(content).toContain('QQ_VOICE_SYNTH_TIMEOUT_MS=300000');
    expect(content).not.toContain('VOICE_TTS_GPT_WEIGHTS=/data/voice/tts/models/sakiko_v2pp-e15.ckpt');
    expect(content).not.toContain('VOICE_TTS_REF_BLACK=/data/voice/tts/references/black_sakiko.wav');
  });

  it('ships a dedicated server env template with tailnet TTS routing', () => {
    const content = readFileSync(resolve(process.cwd(), '.env.server.example'), 'utf8');

    expect(content).toContain('QQ_VOICE_ASR_BASE_URL=http://127.0.0.1:5161');
    expect(content).toContain('QQ_VOICE_TTS_BASE_URL=http://your-laptop.tailnet.ts.net:5162');
    expect(content).toContain('QQ_VOICE_TTS_API_KEY=qqbot-voice-tts-token');
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

  it('restarts the full compose stack during deploy instead of a hard-coded subset', () => {
    const content = readFileSync(resolve(process.cwd(), '.github/workflows/deploy.yml'), 'utf8');

    expect(content).toContain('ExecStart=/usr/bin/podman-compose -f ${APP_DIR}/compose.yaml up -d --build');
    expect(content).toContain('ExecStop=/usr/bin/podman-compose -f ${APP_DIR}/compose.yaml stop');
    expect(content).toContain("--exclude='.env.local'");
    expect(content).toContain("--exclude='.env.server'");
    expect(content).toContain("cat > '${DEPLOY_APP_DIR}/.env.server'");
    expect(content).toContain('EnvironmentFile=${APP_DIR}/.env.server');
    expect(content).not.toContain('up -d ollama pmhq llbot');
  });

  it('lets stickers sync resolve local env first and server env second', () => {
    const content = readFileSync(resolve(process.cwd(), 'scripts/stickers-sync.mjs'), 'utf8');

    expect(content).toContain("path.resolve(ROOT_DIR, '.env.local')");
    expect(content).toContain("path.resolve(ROOT_DIR, '.env.server')");
    expect(content).not.toContain("path.resolve(ROOT_DIR, '.env')");
  });
});
