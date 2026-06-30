# QQ AI Chat Bot

English | [简体中文](README.zh-CN.md)

A QQ chat bot built with Koishi, OneBot, LLBot, PMHQ, and ChatLuna.

This README is for users who want to install and run a bot. It keeps the setup
path small: install the packages, configure one QQ account and one chat model
provider, start the three runtime processes, then test a message.

## Runtime Layout

- PMHQ runs the QQ client inside Podman.
- LLBot runs on the host, connects to PMHQ, and exposes OneBot WebSocket on
  `127.0.0.1:3001`.
- Koishi runs the bot logic and console on `127.0.0.1:5140`.

The default local runtime uses `.env.local`.

## Requirements

- Linux host. This project is maintained for Fedora with rootless Podman.
- Node.js `>= 22`.
- pnpm `9.15.4`.
- Podman with `podman compose` or `podman-compose`.
- Git, Python 3, curl, unzip support, and ffmpeg.
- One QQ account for the bot.
- One API key for an OpenAI-compatible chat model provider.

On Fedora, install the system tools first:

```bash
sudo dnf install -y git nodejs podman podman-compose python3 curl unzip ffmpeg
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

Check the versions:

```bash
node --version
pnpm --version
podman --version
podman compose version
```

## Install

`qqbot` depends on a sibling ChatLuna checkout. Keep the two repositories side
by side:

```bash
mkdir -p ~/code
cd ~/code

git clone https://github.com/kkkzbh/kbot.git qqbot
git clone --branch v1-dev https://github.com/kkkzbh/chatluna.git chatluna
```

Install ChatLuna dependencies:

```bash
cd ~/code/chatluna
corepack yarn install --no-immutable
```

Install and build the bot:

```bash
cd ~/code/qqbot
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm build
```

If `pnpm build` reports that linked ChatLuna packages need a build, rerun the
same command from `~/code/qqbot`. The build script compiles the linked ChatLuna
packages and this bot's runtime plugins.

## Configure

Edit `.env.local`.

Set your QQ identity:

```dotenv
BOT_OWNER_QQ=123456789
ONEBOT_SELF_ID=987654321
ONEBOT_WS_ENDPOINT=ws://127.0.0.1:3001
```

- `BOT_OWNER_QQ` is your own QQ number.
- `ONEBOT_SELF_ID` is the QQ account that will run the bot.
- Keep `ONEBOT_WS_ENDPOINT` unchanged unless you also change
  `LLONEBOT_WS_PORT`.

Set one chat model provider. The smallest path is the default SiliconFlow tab:

```dotenv
CHATLUNA_ACTIVE_TAB=siliconflow
CHATLUNA_PLATFORM=siliconflow
CHATLUNA_BASE_URL=https://api.siliconflow.cn/v1
CHATLUNA_API_KEY=sk-your-siliconflow-key
CHATLUNA_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5

CHATLUNA_SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
CHATLUNA_SILICONFLOW_API_KEY=sk-your-siliconflow-key
CHATLUNA_SILICONFLOW_DEFAULT_MODEL=Pro/moonshotai/Kimi-K2.5
```

For a first run, disable optional services that need extra API keys or local
voice models:

```dotenv
MEMORY_ENABLED=false
MEMORY_READ_ENABLED=false
MEMORY_WRITE_ENABLED=false
CHATLUNA_SEARCH_SERVICE_ENABLED=false
QQ_VOICE_INPUT_ENABLED=false
QQ_VOICE_OUTPUT_ENABLED=false
```

Group natural trigger is disabled by default. With the default configuration,
the bot replies in private chats and in group chats when it is mentioned or
called by one of the names configured in `CHAT_NATURAL_TRIGGER_ALIASES`.

To enable passive group replies later, set both fields:

```dotenv
CHAT_NATURAL_TRIGGER_ENABLED=true
CHAT_NATURAL_TRIGGER_GROUPS=123456789,987654321
```

## Start

Use three terminals for the first run.

Terminal 1: start PMHQ and watch QQ login logs.

```bash
cd ~/code/qqbot
QQBOT_ENV_FILE=.env.local bash ./scripts/podman-pmhq-service.sh up
podman logs -f pmhq
```

Terminal 2: start LLBot.

```bash
cd ~/code/qqbot
QQBOT_ENV_FILE=.env.local bash ./scripts/run-llbot-host.sh
```

Open the LLBot WebUI after LLBot starts:

```text
http://127.0.0.1:3080
```

Log in to QQ from the PMHQ or LLBot login prompt. LLBot exposes the OneBot
WebSocket server on port `3001` after QQ login completes.

Terminal 3: start Koishi.

```bash
cd ~/code/qqbot
pnpm start:local
```

Open the Koishi console:

```text
http://127.0.0.1:5140/console
```

## Test The Bot

After all three processes are running:

- Send a private message to the bot QQ account.
- Or invite the bot to a group and mention it.
- Or send a group message that starts with one of the configured names.

For a local text-reply smoke test:

```bash
cd ~/code/qqbot
pnpm smoke:chat
```

## Stop

Stop Koishi and LLBot with `Ctrl-C` in their terminals.

Stop PMHQ:

```bash
cd ~/code/qqbot
QQBOT_ENV_FILE=.env.local bash ./scripts/podman-pmhq-service.sh stop
```

## Common Checks

PMHQ is not running:

```bash
podman ps --filter name=pmhq
QQBOT_ENV_FILE=.env.local bash ./scripts/podman-pmhq-service.sh up
```

LLBot WebUI does not open:

```bash
podman logs --tail 200 pmhq
```

Koishi says linked ChatLuna packages need a build:

```bash
cd ~/code/qqbot
pnpm build
```

OneBot WebSocket cannot connect:

```bash
curl http://127.0.0.1:3080/
```

Make sure LLBot is running, QQ login has completed, and `ONEBOT_WS_ENDPOINT` is
`ws://127.0.0.1:3001`.

The bot does not reply in a group:

- Mention the bot or use one of the configured names.
- If you enabled passive group replies, make sure the group number is listed in
  `CHAT_NATURAL_TRIGGER_GROUPS`.
- Check the Koishi terminal for model provider errors.
