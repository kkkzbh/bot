# QQ AI Chat Bot (Fedora + Podman)

Koishi + OneBot + LLOneBot + ChatLuna implementation for Fedora 43 (KDE/Wayland).

## 1. Prerequisites

- Node.js >= 22
- pnpm >= 9
- Podman >= 5

## 2. Install

```bash
pnpm install
cp .env.example .env.local
cp .env.server.example .env.server
```

Edit `.env.local` for local runtime and `.env.server` for server deploy/runtime. Set at least:

- `ONEBOT_SELF_ID`
- `SQLITE_PATH`
- `CHATLUNA_ACTIVE_TAB`
- `CHATLUNA_PLATFORM`
- `CHATLUNA_BASE_URL`
- `CHATLUNA_API_KEY`
- `CHATLUNA_DEFAULT_MODEL`
- `CHATLUNA_SILICONFLOW_BASE_URL`
- `CHATLUNA_SILICONFLOW_API_KEY`
- `CHATLUNA_SILICONFLOW_DEFAULT_MODEL`
- `CHATLUNA_OPENAI_BASE_URL`
- `CHATLUNA_OPENAI_API_KEY`
- `CHATLUNA_OPENAI_DEFAULT_MODEL`
- `CHATLUNA_COPILOT_BASE_URL`
- `CHATLUNA_COPILOT_API_KEY`
- `CHATLUNA_COPILOT_DEFAULT_MODEL`
- `CHATLUNA_COPILOT_OAUTH_CLIENT_ID`
- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `MEMORY_EMBED_API_KEY`
- `CHATLUNA_COMMAND_AUTHORITY`

Main chat provider selection is fixed to three built-in tabs:

- `siliconflow`: current Kimi main-chat chain
- `openai`: OpenAI-compatible provider tab, defaulting to `wyzai` with `openai/gpt-5.4-medium-thinking`
- `copilot`: GitHub Copilot OAuth tab, defaulting to the local bridge `http://127.0.0.1:5140/api/internal/copilot/v1` with `gpt-5.4-mini`

`CHATLUNA_ACTIVE_TAB` selects which built-in tab is mirrored into the runtime
keys `CHATLUNA_PLATFORM` / `CHATLUNA_BASE_URL` / `CHATLUNA_API_KEY` /
`CHATLUNA_DEFAULT_MODEL`.

Each built-in tab now maps to a provider strategy bundle rather than only an
endpoint preset:

- `siliconflow` uses the existing `chat/completions` main-chat path and Kimi-specific non-thinking override
- `openai` uses the OpenAI-compatible GPT-5.4 strategy, including `responses` mode and provider-specific structured-output wiring
- `copilot` uses GitHub device-flow OAuth, exchanges GitHub token into a short-lived Copilot session token at runtime, and serves ChatLuna through a local Responses bridge

## Developer docs (web)

This repository includes a VitePress documentation site for developers only.

Source files are in:

- `web/`

Run docs locally:

```bash
pnpm docs:dev
```

Build static docs:

```bash
pnpm docs:build
```

Preview built docs:

```bash
pnpm docs:preview
```

## 3. Start Koishi bot (host)

```bash
pnpm start
```

`pnpm start` will build `dist/`, then resolve bot env in this order:

- `.env.local`

Then it runs `koishi start koishi.yml`.

Koishi listens on `KOISHI_HOST:KOISHI_PORT` (default `0.0.0.0:5140`).

Koishi uses **OneBot WebSocket 正向连接** to LLBot:

- `ONEBOT_WS_ENDPOINT=ws://127.0.0.1:3001`
- Only OneBot protocol is supported in this project.

Long-memory v2 stores only extracted long-term facts and episode summaries in local SQLite.
Embeddings are only used for long-memory recall/writeback and are expected to come from SiliconFlow (`Qwen/Qwen3-Embedding-8B` by default).

## 4. Start PMHQ + host LLBot

```bash
podman compose pull pmhq
podman compose up -d pmhq
bash ./scripts/run-llbot-host.sh
```

Official runtime mode uses:

- `pmhq`: QQ client runtime and login session
- `llbot`: host-native OneBot + WebUI
- `voice-asr`: `faster-whisper small/int8 + ffmpeg` HTTP service for QQ voice transcription
- `compose.yaml` now keeps only `pmhq` and `voice-asr`; LLBot is downloaded from upstream release zips and started on host by `scripts/run-llbot-host.sh`.
- `llbot` must talk to `pmhq` through `127.0.0.1:${PMHQ_PORT}`.
- LLBot host ports are pinned to loopback (`127.0.0.1:3001` and `127.0.0.1:3080`) so Koishi and SSH local-forwards use the same endpoint on both laptop and server.

Watch login logs (QR code / login progress):

```bash
podman compose logs -f pmhq
```

Open WebUI after services are up:

- `http://127.0.0.1:${LLONEBOT_WEBUI_PORT}` (default `3080`)

Then in LLBot WebUI enable **WebSocket正向** (server mode) on port `3001`.

If token is set, keep LLBot token consistent with `ONEBOT_TOKEN`.

`qqbot-pmhq.service` also exports a dedicated Podman `containers.conf` with
`keyring = false` to avoid rootless `runc` startup failures caused by exhausted
session key quotas on the host.

### 4.1 QQ voice services (server ASR + laptop TTS with loopback core and optional tailnet publish)

- The server compose stack keeps only ASR on loopback:
  - `QQ_VOICE_ASR_BASE_URL=http://127.0.0.1:5161`
  - `./data/voice/asr/cache/` stores the Whisper cache on the server
- Optional voice replies use different bot envs by runtime role:
  - local bot: set `QQ_VOICE_TTS_BASE_URL=http://127.0.0.1:5162` in `.env.local`
  - server bot: set `QQ_VOICE_TTS_BASE_URL=http://your-laptop.tailnet.ts.net:5162` in `.env.server`
  - if the server cannot resolve MagicDNS reliably, use the laptop Tailscale IP instead, for example `http://100.x.y.z:5162`
  - keep `QQ_VOICE_TTS_API_KEY` identical between the bot env file in use and `config/voice-tts.local.env`
- Server deploy no longer force-disables voice output in systemd.
  - if `QQ_VOICE_OUTPUT_ENABLED=true` on the server, it is expected to call your laptop-local TTS over Tailnet
  - deploy now rejects `QQ_VOICE_OUTPUT_ENABLED=true` when `QQ_VOICE_TTS_BASE_URL` / `QQ_VOICE_TTS_API_KEY` are empty or point at loopback
  - if the laptop-local TTS gateway or its Tailnet publish layer is unavailable, server voice reply should be treated as unavailable rather than silently downgraded to a fake enabled state
- The local TTS gateway itself should only listen on loopback:
  - set `VOICE_TTS_HOST=127.0.0.1` in `config/voice-tts.local.env`
  - do not bind the model process directly to a Tailscale IP
- If the server needs to reach your laptop TTS, publish the loopback gateway separately:
  - use `tailscale serve --tcp 5162 tcp://127.0.0.1:5162`
  - or install the optional `qqbot-voice-tts-tailnet.service`
  - this publish layer does not load another model, so GPU memory usage stays single-copy
- The laptop-local runtime now lives entirely under this repo:
  - upstream wrapper code: `/home/kkkzbh/code/qqbot/.runtime/gpt-sovits-upstream`
  - copied model assets: `/home/kkkzbh/code/qqbot/data/voice/tts-local`
- This repository ships the laptop-local TTS templates:
  - `config/voice-tts.local.example`
  - `config/voice-tts.tailnet.example`
  - `config/systemd/qqbot-voice-tts.service.example`
  - `config/systemd/qqbot-voice-tts-tailnet.service.example`
  - `scripts/run-voice-tts-local.sh`
  - `scripts/publish-voice-tts-tailnet.sh`
  - `scripts/setup-voice-tts-local-runtime.sh`

### 4.2 Start laptop-local TTS gateway

1. Copy `config/voice-tts.local.example` to `config/voice-tts.local.env`.
   Keep `VOICE_TTS_PROMPT_LANG=all_ja` for the bundled Sakiko reference audio and `VOICE_TTS_TEXT_LANG=all_zh` for Chinese bot replies unless you intentionally replace the reference set.
2. Populate the repo-local TTS runtime and copied assets:

```bash
cd /home/kkkzbh/code/qqbot
scripts/setup-voice-tts-local-runtime.sh \
  --source-pretrained-root /path/to/pretrained_models \
  --source-model-root /path/to/GPT-SoVITS_models \
  --source-reference-root /path/to/reference_audio/sakiko
```

3. Create a dedicated virtual environment for the laptop-local TTS gateway:

```bash
cd /home/kkkzbh/code/qqbot
uv venv --python 3.12 .venv-voice-tts
uv pip install --python .venv-voice-tts/bin/python --index-url https://download.pytorch.org/whl/cu124 \
  torch==2.5.1 torchaudio==2.5.1
```

4. Install the gateway and GPT-SoVITS deps into that interpreter:

```bash
uv pip install --python /home/kkkzbh/code/qqbot/.venv-voice-tts/bin/python \
  -r /home/kkkzbh/code/qqbot/docker/voice-tts/requirements-gateway.txt \
  -r /home/kkkzbh/code/qqbot/docker/voice-tts/requirements-upstream.txt
```

5. Smoke test the laptop-local gateway before enabling systemd:

```bash
 QQBOT_VOICE_TTS_ENV_FILE=/home/kkkzbh/code/qqbot/config/voice-tts.local.env \
  /home/kkkzbh/code/qqbot/scripts/run-voice-tts-local.sh
```

6. Install the loopback-only user unit after the manual smoke test passes:

```bash
mkdir -p ~/.config/systemd/user
cp /home/kkkzbh/code/qqbot/config/systemd/qqbot-voice-tts.service.example \
  ~/.config/systemd/user/qqbot-voice-tts.service
systemctl --user daemon-reload
systemctl --user enable --now qqbot-voice-tts.service
```

7. Optional: if the server bot should access this laptop TTS over Tailnet, publish the loopback gateway instead of rebinding the model process:

```bash
cp /home/kkkzbh/code/qqbot/config/voice-tts.tailnet.example \
  /home/kkkzbh/code/qqbot/config/voice-tts.tailnet.env
mkdir -p ~/.config/systemd/user
cp /home/kkkzbh/code/qqbot/config/systemd/qqbot-voice-tts-tailnet.service.example \
  ~/.config/systemd/user/qqbot-voice-tts-tailnet.service
systemctl --user daemon-reload
systemctl --user enable --now qqbot-voice-tts-tailnet.service
```

If `tailscale serve` reports permission denied, grant your user operator access once:

```bash
sudo tailscale set --operator=$USER
```

### 4.3 Fixed local chat smoke cases

After the local bot chain is running, use the fixed chat smoke suite to regression-test text reply, protocol-leak avoidance, sticker reply, and voice reply:

```bash
cd /home/kkkzbh/code/qqbot
pnpm smoke:chat
```

The suite reuses a single fake private chat for the current run and prints only:
- input prompt
- final visible output summary
- pass/fail result

By default it generates a fresh `FAKE_USER_ID` for each smoke run, then reuses it serially within that run to avoid private-room creation races. Override `FAKE_USER_ID` or `BOT_TIMEOUT_SECONDS` only when needed.
The script now also removes the debug-generated private room, conversation, messages, and fake user on exit, so successful and failed runs do not leave `codex-debug` residue behind.

If you need to manually clean prior debug probes, run:

```bash
cd /home/kkkzbh/code/qqbot
bash ./scripts/cleanup-debug-chat-state.sh
```

## 5. Trigger contract

- Runtime trigger path = `group-natural-trigger` 判定 + ChatLuna allow-reply resolver 接线 + ChatLuna native。
- `reply runtime` 统一接管生成期与发送期中断：
  - 同一会话的新消息会中断旧 run，并以最新消息重新生成。
  - 已经发出的内容不会撤回；未发送的剩余 segment 会被丢弃，并重写历史尾部。
  - `ReplyPlan.multiline` 仍保持原子块发送，但整块发送前可以被新 run 替换。
- 群聊可自然触发，无需 `@` 或句首昵称：
  - 任意消息有 `25%` 概率直接触发对话。
  - 否则走“规则 + 模型”触发判定。
  - 会话焦点窗口 `5` 分钟（同群共享、群间隔离）。
  - 机器人最小回复间隔 `2s`（同群串行等待，不丢消息）。
  - 反刷屏：同一用户 `10s` 内 `10` 条消息，`3` 分钟内忽略该用户。
  - `group-natural-trigger` 负责产出自然触发判定，并通过 ChatLuna service 注册的 allow-reply resolver 把结果接入放行链。
- 昵称触发保留，默认别名包含：
  - `祥子`、`祥`、`丰川`、`丰川祥子`、`saki`、`saki酱`、`sakiko`。
- 自动化任务不再拦截普通消息：
  - 创建入口为 Agent 显式调用 `automation_*` 工具。
  - 到点后会启动一次独立 Agent run，而不是复用当前聊天历史。
  - 自动化 run 最终仍向原群/私聊发送文本结果；群任务默认 `@创建者`。
  - 到点执行时会跟随当前房间的 preset / model / tool-policy，而不是使用创建时快照。

## 6. Command authority

- `chatluna.*` command family is overridden by `@koishijs/plugin-commands`.
- Default required authority is `>= 3` (configurable by `CHATLUNA_COMMAND_AUTHORITY`).
- Passive conversation triggers still work for normal group members (subject to ChatLuna room/trigger settings).

## 7. Task automation tools

- `automation_create`：在当前 plugin 房间按自然语言 `scheduleText` 创建自动化任务，时间解析由代码负责。
- `automation_list`：查看当前房间内由当前用户创建的自动化任务。
- `automation_update`：按自然语言 `scheduleText` 修改现有自动化任务，避免模型自己重写 ISO / cron。
- `automation_pause`：暂停自动化任务。
- `automation_resume`：恢复已暂停的自动化任务。
- `automation_delete`：删除自动化任务。

## 8. SQLite persistence

- SQLite file DB is enabled via `@koishijs/plugin-database-sqlite`.
- Default DB path: `./data/koishi.db` (override with `SQLITE_PATH`).
- No extra DB container is required.
- ChatLuna rooms and context can persist across Koishi restarts.
- 自动化任务也持久化到同一 SQLite 数据库，核心表为 `automation_job` 和 `automation_job_run`。

## 9. Legacy removal status

- Deprecated `group-chat` implementation has been removed:
  - `src/plugins/group-chat.ts`
  - `src/plugins/group-chat-core.ts`
  - `tests/group-chat.test.ts`
  - `src/types/chat.ts`
- Current conversation chain:
  - `chatluna` + `chatluna-openai-like-adapter` + `chatluna-model-guard` + `database-sqlite` + `commands`
- Task automation extension chain:
  - `cron` + `task-automation`
  - 调度器只负责扫描到点任务、启动独立 Agent run、记录执行结果、回投 QQ 消息。

## 10. Group natural trigger environment variables

- `CHAT_NATURAL_TRIGGER_ENABLED`：是否开启群聊自然触发（默认 `true`）。
- `CHAT_NATURAL_TRIGGER_GROUPS`：自然触发白名单群（逗号分隔，留空表示不在任何群自动触发）。
- `CHAT_NATURAL_TRIGGER_ALIASES`：别名列表（逗号分隔）。
- `CHAT_NATURAL_TRIGGER_DIRECT_PROBABILITY`：任意消息直接触发概率（默认 `0.25`）。
- `CHAT_NATURAL_TRIGGER_FOCUS_WINDOW_MS`：会话焦点窗口（默认 `300000`，同群共享）。
- `CHAT_NATURAL_TRIGGER_REPLY_INTERVAL_MS`：机器人最小回复间隔（默认 `2000`，同群串行等待）。
- `CHAT_NATURAL_TRIGGER_SPAM_WINDOW_MS`：刷屏判定窗口（默认 `10000`）。
- `CHAT_NATURAL_TRIGGER_SPAM_THRESHOLD`：刷屏判定阈值（默认 `10`）。
- `CHAT_NATURAL_TRIGGER_SPAM_MUTE_MS`：刷屏忽略时长（默认 `180000`）。
- `CHAT_NATURAL_TRIGGER_DECISION_ENABLED`：是否启用模型判定（默认 `true`）。
- `CHAT_NATURAL_TRIGGER_DECISION_BASE_URL` / `CHAT_NATURAL_TRIGGER_DECISION_API_KEY` / `CHAT_NATURAL_TRIGGER_DECISION_MODEL`：
  - 未设置时复用 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`。
- `CHAT_NATURAL_TRIGGER_DECISION_TIMEOUT_MS`：模型判定超时（默认 `4000`）。
- `CHAT_NATURAL_TRIGGER_DECISION_MIN_CONFIDENCE`：模型判定最小置信度（默认 `0.62`）。

## 11. Task automation environment variables

- `TASK_AUTOMATION_POLL_MS`：一次性任务轮询间隔（默认 `30000`）。
- `TASK_AUTOMATION_MAX_TASKS_PER_USER`：单用户任务上限（默认 `20`）。
- 自动化任务创建与执行都改为 ChatLuna 工具链驱动，不再提供单独的意图模型、到点发送模型或创建回复模型配置。

### QQ voice environment variables

- `QQ_VOICE_INPUT_ENABLED`：是否允许 QQ 语音转写输入（默认 `true`）。
- `QQ_VOICE_OUTPUT_ENABLED`：是否允许可选语音回复（默认 `true`）。
- `QQ_VOICE_ASR_BASE_URL` / `QQ_VOICE_ASR_API_KEY`：Koishi 访问本机 ASR 服务的地址与 token。
- `QQ_VOICE_TTS_BASE_URL` / `QQ_VOICE_TTS_API_KEY`：Koishi 访问 TTS 网关的地址与 token。本地通常指向 `127.0.0.1:5162`；服务器开启语音回复时应指向笔记本 Tailnet TTS 地址。
- `QQ_VOICE_INPUT_MAX_SECONDS`：单条入站语音最大时长（默认 `60` 秒）。
- `QQ_VOICE_OUTPUT_MAX_WORDS`：单个语音段最大词数（默认 `80`；超过时应由模型主动拆成多段语音）。
- `QQ_VOICE_OUTPUT_MAX_SECONDS`：单个语音段最大时长（默认 `45` 秒）。
- `QQ_VOICE_TRANSCRIBE_TIMEOUT_MS`：ASR 请求超时（默认 `45000` 毫秒）。
- `QQ_VOICE_SYNTH_TIMEOUT_MS`：TTS 请求超时（默认 `300000` 毫秒）。
- Server compose env:
  - `VOICE_ASR_PORT` / `VOICE_ASR_MODEL` / `VOICE_ASR_COMPUTE_TYPE`
- Laptop-local TTS env:
  - see `config/voice-tts.local.example`
  - key knobs are `VOICE_TTS_PYTHON_BIN`, `VOICE_TTS_HOST`, `VOICE_TTS_DEVICE`, `VOICE_TTS_IS_HALF`, `VOICE_TTS_MAX_TEXT_CHARS`, `VOICE_TTS_UPSTREAM_ROOT`, `VOICE_TTS_PRETRAINED_ROOT`, `VOICE_TTS_MODEL_ROOT`, and `VOICE_TTS_REFERENCE_ROOT`
- Quick rollback:
  - set `QQ_VOICE_INPUT_ENABLED=false` and/or `QQ_VOICE_OUTPUT_ENABLED=false`, then restart `qqbot.target`.

## 12. Quality checks

```bash
pnpm docs:build
pnpm typecheck
pnpm test
pnpm build
```

## 13. Fedora / Podman notes

- This project is built for Podman (not Docker Desktop).
- `compose.yaml` uses `:Z` on bind mount for SELinux Enforcing.
- `pmhq` stays containerized, but LLBot and Koishi both run on host.
- `llbot` must call `pmhq` through `127.0.0.1:${PMHQ_PORT}`, never container DNS names.
- `llonebot` runtime data must live in an environment-specific directory (`LLONEBOT_DATA_DIR`), not in the deploy payload. Local default is `./.runtime/llonebot`; server default is `/opt/qqbot/shared/llonebot`.
- Extracted LLBot program files must live in `LLBOT_RUNTIME_DIR`. Local default is `./.runtime/llbot`; server default is `/opt/qqbot/shared/llbot-runtime`.
- On every boot, `scripts/run-llbot-host.sh` prepares the upstream release, rewrites the managed transport fields in both `default_config.json` and each `config_*.json`, patches LLBot media-path resolution from `/root/.config/QQ/...` into the host PMHQ QQ volume, and keeps WebUI / forward-WS / token repo-controlled while account login state remains environment-local.
- `QQBOT_QQ_CONFIG_MOUNT_SOURCE` is an optional override for the PMHQ QQ volume path when `podman inspect pmhq` cannot be used to resolve it automatically.
- `PMHQ_BIND_HOST` only controls how `pmhq` is exposed to the host; it does not participate in container-to-container addressing.
- Server runtime may keep `AUTO_LOGIN_QQ` enabled for normal quick-login boot.
- One QQ account should have exactly one active quick-login edge at a time. If laptop-local and server both set the same `AUTO_LOGIN_QQ`, expect one side to wedge into `登录系统连接异常`, stale QR state, or broken quick-login.
- If server quick-login wedges QQ into `登录系统连接异常` or blocks QR fetch, run `scripts/server-recover-qq-login.sh prepare`, complete one manual login in LLBot WebUI, then run `scripts/server-recover-qq-login.sh restore` to return to auto-login.

## 14. Troubleshooting

- No reply in group:
  - Confirm ChatLuna is loaded and DeepSeek adapter is loaded.
  - Confirm trigger pattern matches ChatLuna native rules (`@`/昵称/私聊).
- 自动化未触发：
  - 确认 `./dist/plugins/automation` 与 `cron` 已在 `koishi.yml` 启用。
  - 确认当前会话对应房间 `chatMode=plugin`，且 Agent 侧允许调用 `automation_*` 工具。
  - 确认控制台 `automation` route 下的工具策略允许到点 run 使用所需工具。
- OneBot WS cannot connect:
  - Confirm Koishi process is running.
  - Confirm LLBot `WebSocket正向` is enabled at `3001`.
  - LLBot `7.11.0` only starts `3001` after QQ login succeeds; if `pmhq` logs `quick login failed` / `登录系统连接异常`, treat a missing `3001` listener as a login-state problem instead of a network/bootstrap problem.
  - If QQ has not finished login yet, do not treat a missing `3001` listener as a stack bootstrap failure; verify LLBot WebUI and `PMHQ WebSocket 连接成功` first.
  - Confirm `ONEBOT_WS_ENDPOINT` points to LLBot OneBot WS endpoint.
  - Confirm `scripts/verify-qqbot-host-runtime.sh` passes on host.
- No QR/login prompt:
  - Check `podman compose logs -f pmhq` instead of only checking `llbot` logs.
  - Confirm `pmhq` container is `Up` and healthy.
  - Confirm local and server are not sharing the same `AUTO_LOGIN_QQ` at the same time for one QQ account.
  - Confirm `LLONEBOT_DATA_DIR` is environment-specific; server should use `/opt/qqbot/shared/llonebot`, not `/opt/qqbot/current/data/llonebot`.
  - If server auto-login gets stuck in `登录系统连接异常`, do not permanently disable it. Use `scripts/server-recover-qq-login.sh prepare`, complete one manual login, then `scripts/server-recover-qq-login.sh restore`.
- Model call fails:
  - Check `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`.
  - Recommended DeepSeek endpoint is `https://api.deepseek.com/v1`.
  - Check network/proxy for model endpoint.
- Command denied:
  - `chatluna.*`：确认账号 authority >= `CHATLUNA_COMMAND_AUTHORITY`。
- QQ 语音不可用：
  - 服务器部署默认禁用语音；不要在服务器上排查 `voice-asr`，它不应该存在。
  - 确认笔记本 `qqbot-voice-tts.service` 已启动：`systemctl --user status qqbot-voice-tts.service`
  - 确认笔记本 TTS 可以在 tailnet 内访问：`curl -H "Authorization: Bearer $QQ_VOICE_TTS_API_KEY" http://<laptop-tailnet-host>:5162/healthz`
  - 确认 `QQ_VOICE_*` 地址与 token 和当前运行角色对应的 env 文件一致：本地看 `.env.local`，服务器看 `.env.server`
  - 确认 `config/voice-tts.local.env` 中仓库内 `data/voice/tts-local/**` 路径有效
  - 若声音几乎无声，先检查 `VOICE_TTS_PROMPT_LANG` 是否与参考音频一致；当前仓库内 Sakiko 参考音频应为 `all_ja`
  - 只想回退文本时，直接关闭 `QQ_VOICE_INPUT_ENABLED` 或 `QQ_VOICE_OUTPUT_ENABLED`

## 16. Run as `systemd --user` (recommended)

This project can be managed as a user-level systemd stack so you do not need to keep WebStorm open.

Installed unit files:

- `/home/kkkzbh/.config/systemd/user/qqbot-pmhq.service`
- `/home/kkkzbh/.config/systemd/user/qqbot-llbot.service`
- `/home/kkkzbh/.config/systemd/user/qqbot-koishi.service`
- `/home/kkkzbh/.config/systemd/user/qqbot.target`

`qqbot-pmhq.service` starts/stops the PMHQ Podman service defined in `compose.yaml`.
`qqbot-llbot.service` runs LLBot on host with release files under `LLBOT_RUNTIME_DIR`.
`qqbot-koishi.service` runs Koishi on host with `/home/kkkzbh/code/qqbot/.env.local` as the canonical local env file.
Server-side startup should explicitly use `/home/kkkzbh/code/qqbot/.env.server`.
It sets `NODE_USE_ENV_PROXY=1` and proxy variables to match `~/.zshrc`:
`http_proxy` / `https_proxy` / `all_proxy` / `no_proxy`
and uppercase variants.
`qqbot.target` groups all three units for one-command start/stop.

Reload units after changes:

```bash
systemctl --user daemon-reload
```

Start or stop the full stack:

```bash
systemctl --user start qqbot.target
systemctl --user stop qqbot.target
```

Enable auto start on login:

```bash
systemctl --user enable qqbot.target
```

Enable linger so services can run without an active desktop login:

```bash
loginctl enable-linger kkkzbh
```

## 17. `systemd` logs and troubleshooting

Check unit status:

```bash
systemctl --user status qqbot-pmhq.service
systemctl --user status qqbot-llbot.service
systemctl --user status qqbot-koishi.service
systemctl --user status qqbot.target
```

Follow Koishi logs:

```bash
journalctl --user -u qqbot-koishi.service -f
```

Follow laptop-local TTS logs:

```bash
journalctl --user -u qqbot-voice-tts.service -f
```

Follow container login logs:

```bash
podman compose -f /home/kkkzbh/code/qqbot/compose.yaml logs -f pmhq
```

Common issues:

- `qqbot-koishi.service` fails with `ExecStart`: confirm configured pnpm path exists (current file uses `/home/kkkzbh/.local/bin/pnpm`; check with `which pnpm`).
- `qqbot-pmhq.service` fails: confirm Podman compose plugin is installed and `compose.yaml` exists.
- `qqbot-llbot.service` fails: confirm host `node` exists and `LLBOT_RUNTIME_DIR` is writable.
- Image sends fail with `reply plan delivery failed ... retcode: 1200`:
  - Check `/opt/qqbot/shared/llonebot/logs/llbot-*.log` for `copyfile ... -> /root/.config/QQ/... ENOENT`.
  - If present, PMHQ returned a container-internal QQ media path that was not rewritten to the host PMHQ volume path before `llbot` copied the file.
  - The managed host runtime is expected to rewrite `/root/.config/QQ/...` into the resolved Podman QQ volume source; if that rewrite is missing or the bundle patch fails, treat it as a runtime prepare regression instead of a Koishi/CF/image-generation problem.
- Service not started after reboot: confirm `systemctl --user is-enabled qqbot.target` and `loginctl show-user kkkzbh | grep Linger`.
- Host logs grow too quickly:
  - deploy installs `/etc/systemd/journald.conf.d/qqbot.conf` plus a root timer `qqbot-log-maintenance.timer` when `sudo -n` is available
  - journald is capped to `512M` persistent + `128M` runtime
  - the maintenance timer runs daily, uses a dedicated `logrotate` policy with `su root syslog` when `/var/log/syslog` exceeds `100M`, and vacuums old journal data

## 18. GitHub CI/CD auto deploy (push to `main`)

This repo now includes:

- `/.github/workflows/ci.yml`
- `/.github/workflows/deploy.yml`

Behavior:

- `CI` runs on every `push` / `pull_request` (`pnpm typecheck`, `pnpm test`, `pnpm build`).
- `Deploy` runs on `push` to `main` (or manual `workflow_dispatch`).
- `Deploy` SSHes to your server, `rsync`s project files, then runs `pnpm install`, `pnpm build`, and restarts `qqbot.target`.
- The generated deploy units are `qqbot-pmhq.service`, `qqbot-llbot.service`, `qqbot-koishi.service`, and `qqbot.target`.
- Deploy verifies `pmhq` health, LLBot WebUI, the `PMHQ WebSocket 连接成功` log, and Koishi-to-LLBot websocket reachability through `scripts/verify-qqbot-host-runtime.sh`.
- Laptop-local `qqbot-voice-tts.service` is not managed by GitHub Actions and must be updated separately on your own machine.

### 18.1 GitHub Actions secrets (required)

- `QQBOT_SERVER_HOST`: deploy server host/IP
- `QQBOT_SERVER_USER`: SSH login user
- `QQBOT_SSH_PRIVATE_KEY`: private key used by GitHub Actions to login server
- `QQBOT_SSH_KNOWN_HOSTS`: optional but recommended (`ssh-keyscan` output)
- `QQBOT_DOTENV`: production `.env.server` full content (multiline secret)

### 18.2 GitHub Actions variables (optional)

- `QQBOT_SERVER_PORT` (default: `22`)
- `QQBOT_SERVER_APP_DIR` (default: `/opt/qqbot/current`)
- `QQBOT_SYSTEMD_TARGET` (default: `qqbot.target`)

### 18.3 One-time server preparation

1. Prepare deploy directory (example uses default path, root user deploy):

```bash
sudo mkdir -p /opt/qqbot/current /opt/qqbot/chatluna /root/.config/systemd/user
sudo chown -R root:root /opt/qqbot
```

2. Install runtime dependencies on server (Ubuntu example):

```bash
sudo apt-get update
sudo apt-get install -y curl git podman podman-compose rsync sqlite3 wget
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
wget -q -O /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt-get install -y /tmp/google-chrome-stable_current_amd64.deb
sudo apt-get purge -y chromium-browser || true
sudo snap remove --purge chromium || true
sudo corepack enable
sudo corepack prepare pnpm@9.15.4 --activate
```

Server deploy is pinned to `.deb` Google Chrome for Puppeteer. Do not install the
`chromium-browser` transition package or rely on the Chromium snap on Ubuntu.

3. Enable linger so `systemd --user` services survive logout:

```bash
sudo loginctl enable-linger root
```

4. In GitHub repo settings, set secret `QQBOT_DOTENV` to your production `.env.server` content.

`Deploy` will sync this secret to `${QQBOT_SERVER_APP_DIR}/.env.server` every run.

5. Ensure root user-level systemd is usable:

```bash
sudo -i systemctl --user daemon-reload
sudo -i systemctl --user status
```

6. `Deploy` will auto-provision user units (`qqbot-pmhq.service`, `qqbot-llbot.service`, `qqbot-koishi.service`, `qqbot.target`)
when `QQBOT_SYSTEMD_TARGET=qqbot.target`.

7. If you use a custom target (not `qqbot.target`), manage that unit yourself and keep
`QQBOT_SYSTEMD_TARGET` consistent.

8. Ensure your `systemd --user` units are enabled:

```bash
systemctl --user daemon-reload
systemctl --user enable qqbot.target
loginctl enable-linger root
```

### 18.4 First push to GitHub

```bash
git remote add origin git@github.com:kkkzbh/kbot.git
git branch -M main
git push -u origin main
```

After this push, GitHub Actions will run CI and then deploy automatically.

### 18.5 Manual deploy trigger

GitHub repo -> `Actions` -> `Deploy` -> `Run workflow`.

### 18.6 Common deploy failures

- `User systemd bus not available`:
  - run `loginctl enable-linger <server_user>` on server, and ensure user service session bus exists.
- `pnpm is not installed on target host`:
  - install Node.js/corepack on server, or ensure `pnpm` is in the deploy user's `PATH`.
- `podman-compose is not installed on target host`:
  - install Podman and `podman-compose` on server.
- `Error: no chrome installations found`:
  - server Puppeteer requires `.deb` Google Chrome in `PATH`; do not use Ubuntu's `chromium-browser` snap transition package.
- `Cannot find module '/opt/qqbot/chatluna/node_modules/@chatluna/.../lib/index.cjs'`:
  - update to the latest `qqbot` scripts and redeploy; startup now auto-builds linked ChatLuna workspace runtime dependencies recursively.
- voice containers fail during startup:
  - confirm `./data/voice/**` exists on server and contains the required models/reference audio before restarting `qqbot.target`.
- SSH failure:
  - verify `QQBOT_*` secrets and `known_hosts` content.
