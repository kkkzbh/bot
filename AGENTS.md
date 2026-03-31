# AGENTS.md

## 运行方式（简版）
- Bot 现在以本地运行和本地调试为主，不再默认部署在服务器上。
- 需要验证行为时，直接在当前工作区启动和调试，不要优先假设线上环境。

- Bot 环境变量按角色分离：
  - 本地运行使用 `/home/kkkzbh/code/qqbot/.env.local`
  - 服务器部署使用 `/home/kkkzbh/code/qqbot/.env.server`

## systemd 拓扑（本地 user 级）
- `qqbot.target`：本地总目标，统一编排 bot 主链路。
- `qqbot-stack.service`：负责 Podman Compose 里的 `pmhq + llbot`，命令来自 `/home/kkkzbh/code/qqbot/compose.yaml`。
- `qqbot-koishi.service`：负责在宿主机内执行 `pnpm start` 启动 Koishi；本地默认读取 `/home/kkkzbh/code/qqbot/.env.local`。
- `qqbot.target` 当前直接 `Wants=qqbot-stack.service qqbot-koishi.service`，并在 `qqbot-stack.service` 之后拉起 Koishi。
- 常用命令：`systemctl --user restart qqbot.target`
- 状态查看：`systemctl --user status qqbot-stack.service qqbot-koishi.service qqbot.target`
- Koishi 日志：`journalctl --user -u qqbot-koishi.service -f`
- 容器日志：`podman compose -f /home/kkkzbh/code/qqbot/compose.yaml logs -f pmhq`
- 另有独立的 `qqbot-voice-tts.service`，用于本机 TTS 网关；它不属于 `qqbot.target`，需要单独管理。

## 服务器最小化部署现状
- 服务器固定为 `root@8.217.82.246`，不再使用 `qqbot` 用户。
- 服务器部署代码来源固定为 GitHub Actions checkout + 同步，不再从当前工作区直接 `rsync` 到线上。
- 线上应用目录固定为 `/opt/qqbot/current`，联动的本地 fork `chatluna` 目录为 `/opt/qqbot/chatluna`。
- `chatluna` 固定使用你的 fork：`https://github.com/kkkzbh/chatluna.git`，不要切回上游仓库假设。
- `qqbot` 当前直接 link 到 `chatluna` 的 4 个包：`core`、`adapter-openai-like`、`extension-tools`、`service-search`；本地与服务器启动前都要确保这些 linked package 的 `lib/` 已构建。
- 服务器运行态使用 `root` 的 user-level systemd：unit 位于 `/root/.config/systemd/user`，目标仍是 `qqbot.target`。
- 不要重建旧的 `/etc/systemd/system/qqbot*.service` 或 `/etc/systemd/system/qqbot.target`；线上只认 root user-level unit。
- 线上环境变量文件为 `/opt/qqbot/current/.env.server`，来源是 GitHub secret `QQBOT_DOTENV`。
- 服务器部署不支持 `voice-asr`，不要在服务器上构建或启动它。
- 服务器若开启 `QQ_VOICE_OUTPUT_ENABLED=true`，语义上必须通过笔记本本地 TTS 的 Tailnet 地址提供语音回复；若笔记本本地 TTS 或 Tailnet 发布未就绪，则该能力应视为不可用。
- 服务器容器栈只拉起 `pmhq + llonebot`；voice 仅保留本地环境。
- 服务器最小运行面固定为 `pmhq + llonebot + koishi`，不要额外恢复旧容器、旧 systemd 单元或 voice 相关服务。
- 当前常用线上排查命令：`ssh -o ClearAllForwardings=yes bot 'systemctl --user status qqbot.target qqbot-stack.service qqbot-koishi.service'`
- 当前本机已约定 `ssh bot` 作为入口，并自带 SSH 隧道：本地 `13080 -> 服务器 3080`（WebUI），本地 `15140 -> 服务器 5140`（Koishi 控制台）。
- 若需要只执行远程命令而不占用本地转发端口，追加 `-o ClearAllForwardings=yes`。

## 注意
1. 不要忽略 bot 的双环境配置；新增或修改 bot 环境变量时，必须同步检查 `.env.example`（本地模板）、`.env.server.example`（服务器模板）、`.env.local`、`.env.server`
2. 我不希望代码中出现大量任何手动兜底清洗的句子，当出现BUG/模型回复效果差/功能异常，你首要任务是想办法让模型做出正确的行为，而不是自己写代码兜底/清洗/纠正错误的模型输出，你要基于这个原则去解决BUG
3. 不要写太多兜底代码，当前出于项目开发阶段，编写简洁的代码是第一位，写代码优先考虑架构和设计，出问题了再及时调整结构和设计即可，不要过渡设计，不要过渡防御性代码，升级与修改，不要考虑兼容性，旧代码及时删除。记住一个原则，系统的核心逻辑是第一位，尽早崩溃的代码才更有助于项目开发发展
4. 本项目依赖的chatluna为本地fork版本，位于 ~/code/chatluna，与qqbot一起维护。
