# AGENTS.md

## 运行方式（简版）
- Bot 现在以本地运行和本地调试为主，不再默认部署在服务器上。
- 需要验证行为时，直接在当前工作区启动和调试，不要优先假设线上环境。

## 更新流程
- 日常更新方式：修改本地代码后直接本地验证。
- 每次提交 Git 不要求 push；除非用户明确要求，否则不要执行 `git push`。
- Debug 直接走本地调试流程，优先通过修改本地代码、运行本地服务、查看本地日志来定位问题。
- 不要为了调试去改服务器环境、部署流程或 `deploy.yml`；只有用户明确要求部署相关操作时才处理。
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

## 本地调试
- 默认使用本机环境进行启动、重启、日志查看和问题复现。
- 如果需要运行命令、补环境变量或调整本地启动方式，直接在当前仓库内处理。
- 本地命令行启动默认使用 `.env.local`；如需显式指定，可用 `pnpm start:local`。

## 注意
不要忽略 bot 的双环境配置；新增或修改 bot 环境变量时，必须同步检查 `.env.example`（本地模板）、`.env.server.example`（服务器模板）、`.env.local`、`.env.server`
任何模型自身错误的输出问题应该通过系统提示词或其他地方的提示词注入或任何LLM Agent工程的方式来减少模型犯错误的可能，而不是自己手动对模型的错误进行处理来兜底
