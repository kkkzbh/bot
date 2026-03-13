import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('qq voice config wiring', () => {
  it('loads the qq-voice plugin before group trigger and chatluna', () => {
    const content = readFileSync(resolve(process.cwd(), 'koishi.yml'), 'utf8');
    const voiceIndex = content.indexOf('./dist/plugins/qq-voice:voice:');
    const triggerIndex = content.indexOf('./dist/plugins/group-natural-trigger:natural-trigger:');
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
    expect(content).toContain('voice-tts:');
    expect(content).toContain('"127.0.0.1:${VOICE_ASR_PORT:-5161}:8080"');
    expect(content).toContain('"127.0.0.1:${VOICE_TTS_PORT:-5162}:8080"');
    expect(content).toContain('./data/voice/asr:/data/voice/asr:Z');
    expect(content).toContain('./data/voice/tts:/data/voice/tts:Z');
  });

  it('documents voice env vars in .env.example', () => {
    const content = readFileSync(resolve(process.cwd(), '.env.example'), 'utf8');

    expect(content).toContain('QQ_VOICE_ENABLED=true');
    expect(content).toContain('QQ_VOICE_ASR_BASE_URL=http://127.0.0.1:5161');
    expect(content).toContain('QQ_VOICE_TTS_BASE_URL=http://127.0.0.1:5162');
    expect(content).toContain('VOICE_TTS_GPT_WEIGHTS=/data/voice/tts/models/sakiko_v2pp-e15.ckpt');
    expect(content).toContain('VOICE_TTS_REF_BLACK=/data/voice/tts/references/black_sakiko.wav');
  });

  it('adds qqbot voice tag contract to the sakiko preset', () => {
    const content = readFileSync(resolve(process.cwd(), 'data/chathub/presets/sakiko.yml'), 'utf8');

    expect(content).toContain('## 语音附加规则');
    expect(content).toContain('默认只发文本，不要主动使用语音标签');
    expect(content).toContain('一次回复里最多只能出现一个 `<qqbot-voice>` 块');
  });

  it('restarts the full compose stack during deploy instead of a hard-coded subset', () => {
    const content = readFileSync(resolve(process.cwd(), '.github/workflows/deploy.yml'), 'utf8');

    expect(content).toContain('ExecStart=/usr/bin/podman-compose -f ${APP_DIR}/compose.yaml up -d --build');
    expect(content).toContain('ExecStop=/usr/bin/podman-compose -f ${APP_DIR}/compose.yaml stop');
    expect(content).not.toContain('up -d ollama pmhq llbot');
  });
});
