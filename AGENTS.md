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

## 注意
1. 不要忽略 bot 的双环境配置；新增或修改 bot 环境变量时，必须同步检查 `.env.example`（本地模板）、`.env.server.example`（服务器模板）、`.env.local`、`.env.server`
2. 我不希望代码中出现大量任何手动兜底清洗的句子，当出现BUG/模型回复效果差/功能异常，你首要任务是想办法让模型做出正确的行为，而不是自己写代码兜底/清洗/纠正错误的模型输出，你要基于这个原则去解决BUG
3. 不要写太多兜底代码，当前出于项目开发阶段，编写简洁的代码是第一位，写代码优先考虑架构和设计，出问题了再及时调整结构和设计即可，不要过渡设计，不要过渡防御性代码，升级与修改，不要考虑兼容性，旧代码及时删除。记住一个原则，系统的核心逻辑是第一位，尽早崩溃的代码才更有助于项目开发发展
4. 本项目依赖的chatluna为本地fork版本，位于 ~/code/chatluna，与qqbot一起维护。
