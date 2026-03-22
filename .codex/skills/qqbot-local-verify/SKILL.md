---
name: qqbot-local-verify
description: qqbot 项目级本地测试、回归与验收 skill。只负责选择并执行最小充分本地验证，包括 bot 真实回复验收与浏览器验收；不负责 Git 提交、push 或部署。
---

# QQBot Local Verify

## Overview

为 `qqbot` 仓库提供固定的本地验证链路：
- 先确认本次改动范围
- 先做最小充分本地回归验证
- 若改动影响 bot 最终回复内容、行为或交互，再做本地 bot 真实验收
- 若改动影响页面或浏览器交互，再做本地真实浏览器验收
- 输出验证结论、证据与阻塞点

本 skill 不负责 Git 提交，不 push，不追踪 Actions，不做服务器部署，不做云端验收。

## 触发场景

当用户出现以下意图时使用本 skill：
- “先回归一下”
- “帮我本地验收”
- “验证 bot 现在怎么回复”
- “看看这个改动有没有回归”
- “先测通，再决定要不要提交”

## 固定流程

1. 范围确认
- 运行 `git status --short`、`git diff --name-only`，确认本次需求对应文件。
- 明确排除无关改动，包括用户已有改动、临时文件、生成噪音。

2. 本地验证
- 先按改动点选择最小充分本地回归：
  - 类型或构建问题优先：`pnpm typecheck`、`pnpm build`
  - 单元或集成逻辑优先：`pnpm test` 或针对性 `vitest` 用例
  - 启动或配置回归优先：`pnpm smoke:start`
  - 固定聊天回归优先：`pnpm smoke:chat`
- 若改动触及 prompt、persona、context 组织、memory、reply plan、voice、sticker、search、live reply、消息发送，或任何会改变 bot 最终回复的链路，必须补本地 bot 真实验收，不能只看脚本退出码。
- 本地 bot 验收默认优先使用：
```bash
bash .codex/skills/qqbot-local-verify/scripts/probe-local-bot.sh "<prompt>"
```
- 若一次要验证多个回复能力（例如文本、语音、表情包、搜索），默认固定同一个 `FAKE_USER_ID`，在同一个私聊调试房间里串行完成，不要每条用一个新房间。
- `probe-local-bot.sh` 必须严格串行发送：
  - 上一个 probe 必须已经返回完整结果后，才能发送下一个 probe。
  - 禁止并发启动多个 probe 进程。
  - 禁止在前一个 probe 仍在等待回复时提前发送下一条消息，否则该轮验收结果作废，必须清理调试房间后重跑。
- 只要本次调试开启了 probe 产生的私聊调试房间，结束后必须删除该调试房间；默认使用：
```bash
bash .codex/skills/qqbot-local-verify/scripts/cleanup-probe-room.sh "<fake_user_id>"
```
- 推荐串行验收写法：
```bash
FAKE_USER_ID=91000999 bash .codex/skills/qqbot-local-verify/scripts/probe-local-bot.sh "你能正常说话吗？请只回复“可以”。"
FAKE_USER_ID=91000999 bash .codex/skills/qqbot-local-verify/scripts/probe-local-bot.sh "请只发一个贴切的表情包，不要文字。"
FAKE_USER_ID=91000999 bash .codex/skills/qqbot-local-verify/scripts/probe-local-bot.sh "液态玻璃是什么？简短说明。"
FAKE_USER_ID=91000999 bash .codex/skills/qqbot-local-verify/scripts/probe-local-bot.sh "请用语音只说“收到”。"
bash .codex/skills/qqbot-local-verify/scripts/cleanup-probe-room.sh 91000999
```
- 验收结论必须建立在 bot 实际回复或实际行为上，而不是脚本是否返回成功。
- 若改动涉及本地 Web / WebUI / 控制台页面 / 浏览器交互，默认优先使用 `MCP` 浏览器工具做本地真实浏览器验收；只有在需要脚本化复现、批量留证或抓取 `console` / `network` / `trace` 时才改用 `Playwright skill`。
- 若验证失败，优先修正 prompt、context、tool 调用链、数据来源或模型约束，不要先写大量手动兜底清洗逻辑掩盖问题。

3. 失败回环
- 任一本地验证失败，都先修复再重跑同一批本地验证。
- 任一本地 bot 验收失败，都先修复再重跑同一批本地验证与验收。
- 在问题定位清楚前，不要把失败的结果包装成“已验证通过”。

4. 回报结果
- 必须给出：
  - 执行过的本地验证命令
  - 关键本地验收证据
  - 若做了 bot 本地验收：输入、期望、bot 实际回复或行为、结论
  - 若被阻塞：阻塞点、失败现象、下一步建议

## 本项目约束

- 遵循仓库 `AGENTS.md`：当前默认是“本地运行 + 本地调试 + 本地验证”。
- 本 skill 只负责验证，不负责 `git add`、`git commit`、`git push`。
- 除非用户明确要求，否则不要追踪远端 Actions、不要假设需要服务器部署。
- 本地运行优先复用现有 user-level `systemd` 拓扑与本地日志，但这属于本地验证手段，不是交付后的默认动作。
- 若改动涉及 env，遵循仓库要求同步检查 `.env.example`、`.env.server.example`、`.env.local`、`.env.server`。
- 本地 bot 聊天验收默认优先使用 `.codex/skills/qqbot-local-verify/scripts/probe-local-bot.sh`，并以 bot 实际回复是否符合预期作为最终判定标准。
- 调试期间若使用 probe 打开了私聊调试房间，必须在验收结束后清理房间，不允许把 `codex-debug` / `codex-private` 这类调试房间长期留在库里。
- 多轮 bot 验收默认在同一个调试房间内串行完成，避免一次验收制造多个新上下文。

## 常用命令清单

```bash
# 变更审查
git status --short
git diff --name-only

# 本地验证
pnpm typecheck
pnpm test
pnpm smoke:start
pnpm smoke:chat
pnpm start
pnpm start:local
bash .codex/skills/qqbot-local-verify/scripts/probe-local-bot.sh "你好，请只回复两个字：收到"
FAKE_USER_ID=91000999 bash .codex/skills/qqbot-local-verify/scripts/probe-local-bot.sh "你好，请只回复两个字：收到"
bash .codex/skills/qqbot-local-verify/scripts/cleanup-probe-room.sh 91000999

# 本地运行态与日志
systemctl --user status qqbot-stack.service qqbot-koishi.service qqbot.target
journalctl --user -u qqbot-koishi.service -f
podman compose -f /home/kkkzbh/code/qqbot/compose.yaml logs -f pmhq
systemctl --user status qqbot-voice-tts.service
journalctl --user -u qqbot-voice-tts.service -f
```
