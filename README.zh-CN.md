# QQ AI Chat Bot

[English](README.md) | 简体中文

一个基于 Koishi、OneBot、LLBot、PMHQ 和 ChatLuna 构建的 QQ 聊天机器人。

这份 README 面向想要安装并运行机器人的使用者。路径保持尽量短：安装依赖包，配置一个 QQ 账号和一个聊天模型 provider，启动三个运行时进程，然后发消息测试。

## 运行时结构

- PMHQ 在 Podman 中运行 QQ 客户端。
- LLBot 在宿主机运行，连接 PMHQ，并在 `127.0.0.1:3001` 暴露 OneBot WebSocket。
- Koishi 运行机器人逻辑和控制台，地址是 `127.0.0.1:5140`。

默认本地运行时使用 `.env.local`。

## 环境要求

- Linux 主机。本项目主要维护 Fedora + rootless Podman。
- Node.js `>= 22`。
- pnpm `9.15.4`。
- Podman，带 `podman compose` 或 `podman-compose`。
- Git、Python 3、curl、unzip 支持和 ffmpeg。
- 一个用于机器人的 QQ 账号。
- 一个 OpenAI-compatible 聊天模型 provider 的 API key。

Fedora 上先安装系统工具：

```bash
sudo dnf install -y git nodejs podman podman-compose python3 curl unzip ffmpeg
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

检查版本：

```bash
node --version
pnpm --version
podman --version
podman compose version
```

## 安装

`qqbot` 依赖旁边的 ChatLuna checkout。保持两个仓库并排放置：

```bash
mkdir -p ~/code
cd ~/code

git clone https://github.com/kkkzbh/kbot.git qqbot
git clone --branch v1-dev https://github.com/kkkzbh/chatluna.git chatluna
```

安装 ChatLuna 依赖：

```bash
cd ~/code/chatluna
corepack yarn install --no-immutable
```

安装并构建机器人：

```bash
cd ~/code/qqbot
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm build
```

如果 `pnpm build` 提示 linked ChatLuna packages 需要构建，从 `~/code/qqbot` 再运行一次同样的命令。构建脚本会编译 linked ChatLuna packages 和本机器人的运行时插件。

## 配置

编辑 `.env.local`。

设置 QQ 身份：

```dotenv
BOT_OWNER_QQ=123456789
ONEBOT_SELF_ID=987654321
ONEBOT_WS_ENDPOINT=ws://127.0.0.1:3001
```

- `BOT_OWNER_QQ` 是你自己的 QQ 号。
- `ONEBOT_SELF_ID` 是运行机器人的 QQ 账号。
- 除非同时修改 `LLONEBOT_WS_PORT`，否则保持 `ONEBOT_WS_ENDPOINT` 不变。

设置一个聊天模型 provider。最短路径是默认的 SiliconFlow tab：

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

首次运行时，建议关闭需要额外 API key 或本地语音模型的可选服务：

```dotenv
MEMORY_ENABLED=false
MEMORY_READ_ENABLED=false
MEMORY_WRITE_ENABLED=false
CHATLUNA_SEARCH_SERVICE_ENABLED=false
QQ_VOICE_INPUT_ENABLED=false
QQ_VOICE_OUTPUT_ENABLED=false
```

群聊自然触发默认关闭。默认配置下，机器人会回复私聊，以及群聊中被 @ 或被 `CHAT_NATURAL_TRIGGER_ALIASES` 配置的名称呼叫时回复。

之后如需开启群聊被动回复，同时设置：

```dotenv
CHAT_NATURAL_TRIGGER_ENABLED=true
CHAT_NATURAL_TRIGGER_GROUPS=123456789,987654321
```

## 启动

首次运行建议使用三个终端。

终端 1：启动 PMHQ 并观察 QQ 登录日志。

```bash
cd ~/code/qqbot
QQBOT_ENV_FILE=.env.local bash ./scripts/podman-pmhq-service.sh up
podman logs -f pmhq
```

终端 2：启动 LLBot。

```bash
cd ~/code/qqbot
QQBOT_ENV_FILE=.env.local bash ./scripts/run-llbot-host.sh
```

LLBot 启动后打开 LLBot WebUI：

```text
http://127.0.0.1:3080
```

从 PMHQ 或 LLBot 的登录提示完成 QQ 登录。托管的 LLBot 启动流程会在 `3001` 端口启用 OneBot WebSocket server。

终端 3：启动 Koishi。

```bash
cd ~/code/qqbot
pnpm start:local
```

打开 Koishi 控制台：

```text
http://127.0.0.1:5140/console
```

## 测试机器人

三个进程都运行后：

- 给机器人 QQ 账号发送私聊消息。
- 或把机器人邀请进群并 @ 它。
- 或发送以配置名称开头的群消息。

本地文本回复 smoke test：

```bash
cd ~/code/qqbot
pnpm smoke:chat
```

## 停止

在对应终端用 `Ctrl-C` 停止 Koishi 和 LLBot。

停止 PMHQ：

```bash
cd ~/code/qqbot
QQBOT_ENV_FILE=.env.local bash ./scripts/podman-pmhq-service.sh stop
```

## 常见检查

PMHQ 没有运行：

```bash
podman ps --filter name=pmhq
QQBOT_ENV_FILE=.env.local bash ./scripts/podman-pmhq-service.sh up
```

LLBot WebUI 打不开：

```bash
podman logs --tail 200 pmhq
```

Koishi 提示 linked ChatLuna packages 需要构建：

```bash
cd ~/code/qqbot
pnpm build
```

OneBot WebSocket 无法连接：

```bash
curl http://127.0.0.1:3080/
```

确认 LLBot 正在运行、QQ 登录已完成，并且 `ONEBOT_WS_ENDPOINT` 是 `ws://127.0.0.1:3001`。

机器人在群聊不回复：

- @ 机器人或使用配置的名称之一。
- 如果开启了群聊被动回复，确认群号列在 `CHAT_NATURAL_TRIGGER_GROUPS` 中。
- 检查 Koishi 终端是否有模型 provider 错误。
