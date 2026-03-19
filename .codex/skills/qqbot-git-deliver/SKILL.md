---
name: qqbot-git-deliver
description: 项目级 Git 交付流程（默认本地验证与验收；按需 push、追踪 CI/Deploy、部署后验收）。当用户要求提交、交付、追踪验证结果时使用。
---

# QQBot Git Deliver

## Overview

为 `qqbot` 仓库提供两套固定交付链路：
- 默认本地链路：严格原子提交、本地验证、本地 `systemd --user`/日志/提示词验收，直到通过。
- 显式远端链路：在用户明确要求时再执行推送、追踪 `CI` 与 `Deploy`、并做部署后验收。

核心原则是“默认本地优先，push/部署按需启用”，并输出可审计结果。

Bot 环境变量采用双 env 设计：
- `.env.local`：本地 bot 运行配置
- `.env.server`：服务器 bot 部署配置

## 触发场景

当用户出现以下意图时使用本 skill：
- “帮我提交代码/原子提交”
- “先本地调试/本地验证，再提交”
- “提交但先不要 push”
- “提交后 push 并看 CI/Deploy 结果”
- “追踪部署是否成功”
- “部署后按改动点出测试提示词并验收输出”

## 固定流程

1. 范围确认
- 运行 `git status --short`、`git diff --name-only`，确认本次需求对应文件。
- 明确排除无关改动（包括用户历史改动、临时文件、生成噪音）。

2. 选择交付链路
- 默认走“本地链路”：
  - 用户没有明确要求 `git push`
  - 用户要的是本地调试、本地验收、本地运行
  - 当前目标是先把改动在本机跑通
  - 当前 bot 是本地运行形态时，默认视为“本地链路”，除非用户明确改口要求远端交付
- 只有在用户明确要求 push、追踪 Actions、验证 Deploy、或需要远端环境验收时，才切到“远端链路”。

3. 本地链路：本地验证与验收（默认）
- 本地运行 bot 时，固定顺序是：
  - 先做最小充分回归验证
  - 验证全部通过后，再执行 Git 原子提交
  - 默认不执行 `git push`
- 禁止在本地链路尚未通过前提前提交“待验证代码”；若必须保留中间状态，使用工作区改动而不是提交半成品。
- 先按改动点选择最小充分验证：
  - 类型/构建问题优先：`pnpm typecheck`、`pnpm build`
  - 单元/集成逻辑优先：`pnpm test` 或针对性 `vitest` 用例
  - 启动/配置回归优先：`pnpm smoke:start`
  - 需要完整 bot 行为时：本地拉起运行链路后做提示词或交互验收
- 本地运行优先使用现成 `systemd --user` 拓扑：
  - `qqbot.target`：总目标
  - `qqbot-stack.service`：拉起 `pmhq + llbot`
  - `qqbot-koishi.service`：执行 `pnpm start`；该命令默认优先读取 `.env.local`
  - 常用动作：`systemctl --user restart qqbot.target`
- 本地验收时优先收集可审计证据：
  - 执行过的验证命令
  - 关键日志片段或状态输出来源
  - 输入提示词/触发方式
  - 期望断言
  - 实际输出或实际行为
  - 结论（通过/失败）
- 需要查看运行态时，优先使用：
  - `systemctl --user status qqbot-stack.service qqbot-koishi.service qqbot.target`
  - `journalctl --user -u qqbot-koishi.service -f`
  - `podman compose -f /home/kkkzbh/code/qqbot/compose.yaml logs -f pmhq`
  - 若改动涉及语音：额外查看 `qqbot-voice-tts.service`
- 若本地任一用例失败，必须进入本地 Debug 回环：
  - 本地修复代码（必要时同步 `.env.local`、`.env.example`，以及服务器相关改动对应的 `.env.server`、`.env.server.example`）
  - 重新执行同一批本地验证与验收
  - 默认不要 `git push`
  - 直到本地链路全部通过为止

4. 原子提交
- 只有在当前链路所需验证已经通过后，才进入提交步骤。
- 按“一个功能/修复一个提交”分组。
- 每组执行：`git add <paths>` -> `git diff --cached` -> `git commit -m "<type>: <简体中文描述>"`。
- 禁止把两个独立改动合并进同一提交。
- 本地链路下，提交完成即视为交付完成，不额外 `git push`。

5. 远端链路：同步 DOTENV + 推送（仅在用户明确要求时）
- 优先使用脚本（会把本地 `.env.server` 同步到 GitHub Secret `QQBOT_DOTENV`，再 push）：
```bash
bash .codex/skills/qqbot-git-deliver/scripts/push-with-dotenv.sh
```
- 可选参数：可透传 `git push` 参数，例如 `--force-with-lease`（仅在用户明确要求时使用）。
- 若用户明确要求不更新 `QQBOT_DOTENV`，才退回普通 `git push`。
- 用户明确要求推 `main` 时，先确认本地分支与目标策略再执行。

6. 远端链路：追踪 CI/Deploy
- 执行：
```bash
bash .codex/skills/qqbot-git-deliver/scripts/watch-actions.sh
```
- 该脚本默认追踪 `HEAD` 对应提交：
  - 所有分支：追踪 `CI`
  - `main` 分支：额外追踪 `Deploy`
- 直到 workflow 完成并返回状态码；失败时自动输出失败日志片段。
- 追踪是长耗时步骤，必须避免“无输出卡住”：
  - 在 Codex 中执行时，优先使用 awaiter agent 跑追踪命令；
  - 至少每 30-60 秒回报一次当前 run 状态（queued/in_progress/completed）和 URL；
  - 达到超时仍未完成时，必须返回“当前状态 + run URL + 下一步建议”，禁止无限等待。

7. 远端链路：部署后提示词验收（必须执行）
- 触发条件：`CI`（和 `main` 分支上的 `Deploy`）全部成功后立即执行。
- 先总结“本次改动点”，按改动点设计测试输入提示词（覆盖正常路径、边界路径、异常路径）。
- 默认使用脚本：
```bash
bash .codex/skills/qqbot-git-deliver/scripts/probe-live-bot.sh "<prompt>"
```
- 该脚本固定走“线上 Koishi 进程 + 临时 Node inspector + 合成 OneBot 私聊入站 + 伪通道出站截获”的验收链路：
  - 命中的是真实部署中的 bot 处理链路与模型调用；
  - 不依赖真实 QQ 发消息；
  - 默认只临时开启服务器本机 `127.0.0.1:9229`，结束后自动关闭；
  - 只截获伪会话 `private:<fake_user_id>` 的出站，不影响真实用户消息。
- 同一轮验收中的 `probe-live-bot.sh` 必须串行执行，禁止并发跑多条：
  - ChatLuna 私聊存在“自动建房”路径，并发 probe 可能撞到同一个 fake user 的建房竞态；
  - 已知现象是报错 `UNIQUE constraint failed: chathub_room.roomId`，这属于验收方式问题，不等于本次功能本身有缺陷；
  - 优先复用已经建好的 `FAKE_USER_ID` 对应私聊房间；若必须换 fake user，也要等待上一条 probe 完整结束后再跑下一条。
- 用该脚本执行每条验收用例，记录：
  - 输入提示词
  - 期望输出（关键断言）
  - 实际输出（关键片段）
  - 结论（通过/失败）
- 若脚本返回 `ok=false`、`timeout=true`、无输出，均视为用例失败。
- 若任一用例失败，必须进入 Debug 回环：
  - 本地修复代码（必要时同步 `.env.server`、`.env.server.example`，以及本地链路受影响时对应的 `.env.local`、`.env.example`）；
  - 再次走“原子提交 -> push -> CI/Deploy 追踪 -> 提示词验收”；
  - 直到全部用例通过为止。
- 最终在对话中输出“通过用例”的输入与实际输出，作为验收证据。

8. 回报结果
- 必须给出：
  - 提交哈希与提交信息
  - 采用的是“本地链路”还是“远端链路”
  - 若走本地链路：本地验证命令、关键日志/状态证据、验收用例（输入、期望、实际、结论）
  - 若走远端链路：push 目标（remote/branch）、CI/Deploy 运行 ID、URL、最终结论、提示词验收用例（输入、期望、实际、结论）
- 如果失败，给出失败 job/步骤或失败用例断言，并提出下一步修复动作。

## 给其他模型的提示词模板

```text
你现在执行 qqbot 交付任务，必须严格遵循以下步骤并输出可审计结果：
1) 先做变更范围确认，只包含与本次需求相关文件。
2) 先判断本次应走“本地链路”还是“远端链路”：除非我明确要求 push/Deploy/Actions，否则默认走本地链路；当前 bot 若是本地运行，也默认视为本地链路。
3) 若走本地链路：先做本地验证（typecheck/test/smoke/startup/systemd/logs 中的最小充分组合），再按改动点设计本地 bot 验收，并记录输入、期望断言、实际输出、通过/失败；全部通过后，才按原子提交原则提交代码。
4) 若走远端链路：也先完成本地最小充分验证，再做原子提交，然后使用 push-with-dotenv.sh 推送（除非我明确说不要更新 QQBOT_DOTENV），再用 watch-actions.sh 追踪 CI；若分支为 main 还要追踪 Deploy；必须等到最终结论。
5) 远端链路在 CI/Deploy 成功后，按本次改动点设计 bot 提示词测试（正常/边界/异常），并使用 `.codex/skills/qqbot-git-deliver/scripts/probe-live-bot.sh` 执行线上 bot 测试。
6) 任一失败都要继续 Debug，并重复对应链路，直到全部通过。
7) 最后给出提交哈希、采用的链路，以及对应的验证证据；如果走了远端链路，再补充 push 目标、CI/Deploy 运行 ID 与 URL。
禁止跳过测试、禁止只做口头判断、禁止在本地链路下默认 git push、禁止在验证通过前提前提交半成品。
```

```text
请基于“本次改动点”生成验收提示词：
- 至少 3 条用例，分别覆盖正常路径、边界路径、异常路径。
- 每条用例输出格式固定为：
  - 输入:
  - 期望断言:
  - 失败判定条件:
```

```text
以下用例未通过，请进入 Debug 回环并继续交付，直到全部通过：
<粘贴失败用例与实际输出>
要求：
- 先定位根因并给出最小修复；
- 按当前链路重新提交并重跑验证；若当前任务是远端链路，再继续 push、追踪 CI/Deploy；
- 再跑同一批用例并更新结果；
- 不要新增与问题无关改动。
```

## 本项目约束

- 遵循仓库 `AGENTS.md`：现在默认“本地运行 + 本地调试 + 本地验证”，不是默认服务器部署链路。
- 除非用户明确要求，否则不要执行 `git push`、不要追踪远端 Actions、不要假设需要 Deploy。
- 当前 bot 若以本地 user-level `systemd` 运行，则默认采用“先本地回归验证、通过后再 Git 原子提交、不 push”的顺序。
- Bot env 改动按角色分别维护：本地改 `.env.local` / `.env.example`，服务器改 `.env.server` / `.env.server.example`；不要再把 bot 的本地与服务器配置混写到同一个 `.env` 里。
- 本地调试优先复用现有 user-level `systemd`：`qqbot.target`、`qqbot-stack.service`、`qqbot-koishi.service`；语音相关问题按需查看独立的 `qqbot-voice-tts.service`。
- 远端链路下，部署后 bot 验收允许临时开启服务器本机 Node inspector（`127.0.0.1:9229`）并在验收后关闭；这属于临时调试动作，不改线上代码、不重启服务。
- 远端链路下，部署后 bot 验收默认串行跑 `probe-live-bot.sh`，并优先复用既有 `FAKE_USER_ID`；不要并发制造新的私聊 fake user 房间。
- 不使用破坏性历史操作（`reset --hard`、强推、amend）除非用户明确要求。
- 提交信息使用简体中文，推荐格式：`feat|fix|refactor|test|docs|chore: 描述`。

## 常用命令清单

```bash
# 变更审查
git status --short
git diff --name-only
git diff --cached

# 原子提交
git add <file_or_dir>
git commit -m "fix: 修复自动化时间解析"

# 本地验证
pnpm typecheck
pnpm test
pnpm smoke:start
pnpm start
pnpm start:local

# 本地 systemd / 日志
systemctl --user restart qqbot.target
systemctl --user status qqbot-stack.service qqbot-koishi.service qqbot.target
journalctl --user -u qqbot-koishi.service -f
podman compose -f /home/kkkzbh/code/qqbot/compose.yaml logs -f pmhq
systemctl --user status qqbot-voice-tts.service
journalctl --user -u qqbot-voice-tts.service -f

# 远端推送
# 仅在用户明确要求时：同步本地 .env.server 到 QQBOT_DOTENV 后再推送
bash .codex/skills/qqbot-git-deliver/scripts/push-with-dotenv.sh
# 或传递 git push 参数
bash .codex/skills/qqbot-git-deliver/scripts/push-with-dotenv.sh --tags

# 远端追踪工作流
bash .codex/skills/qqbot-git-deliver/scripts/watch-actions.sh
bash .codex/skills/qqbot-git-deliver/scripts/watch-actions.sh <commit_sha> <branch>
# 可调超时（示例）
WATCH_TIMEOUT_SECONDS=900 RUN_WATCH_TIMEOUT_SECONDS=5400 POLL_INTERVAL_SECONDS=5 \
  bash .codex/skills/qqbot-git-deliver/scripts/watch-actions.sh

# 远端部署后线上 bot 验收
bash .codex/skills/qqbot-git-deliver/scripts/probe-live-bot.sh "你好，请只回复两个字：收到"
# 可调 fake user / timeout；多条用例请串行执行，并尽量复用同一个 FAKE_USER_ID
FAKE_USER_ID=90000123 BOT_TIMEOUT_SECONDS=60 \
  bash .codex/skills/qqbot-git-deliver/scripts/probe-live-bot.sh "测试提示词"
```

```text
# 部署后验收记录模板（建议）
用例1:
输入: <prompt>
期望: <assertions>
实际: <bot output snippet>
结论: 通过|失败
```

```text
# 本地验收记录模板（建议）
用例1:
触发方式: <命令|提示词|操作路径>
期望: <assertions>
实际: <日志片段|返回结果|可观察行为>
结论: 通过|失败
```

## 失败处理

- 本地链路验证失败：
  - 先把失败断言转成最小可复现输入，优先在本地修复并重跑同一批验证。
- `qqbot-koishi.service` 启动失败：
  - 先看 `systemctl --user status qqbot-koishi.service` 与 `journalctl --user -u qqbot-koishi.service -f`；
  - 再确认 `.env.local`（本地）或 `.env.server`（服务器）、`pnpm start`、以及 `pnpm build` 是否正常。
- OneBot / LLBot 本地链路异常：
  - 先确认 `qqbot-stack.service` 已启动；
  - 再看 `podman compose -f /home/kkkzbh/code/qqbot/compose.yaml logs -f pmhq`。
- 语音链路异常：
  - 若改动涉及本机 TTS，检查 `systemctl --user status qqbot-voice-tts.service` 与对应日志。
- `watch-actions.sh` 未找到对应 workflow：
  - 先确认是否刚 push、是否 `gh auth status` 已登录、是否提交 SHA 正确。
- CI 失败：用 `gh run view <id> --log-failed` 提取失败段并定位到文件/测试。
- Deploy 失败：先看 Actions 日志，必要时再按仓库规范去服务器做只读验证（`ssh ascend` 查看服务状态与日志）。
- 提示词验收若报 `UNIQUE constraint failed: chathub_room.roomId`：
  - 先检查是否并发跑了多条 `probe-live-bot.sh` 或同时创建新的 fake user 私聊房间；
  - 该问题通常是 ChatLuna 私聊自动建房竞态，不一定是本次功能回归；
  - 改为串行执行，并优先复用已建好的 `FAKE_USER_ID` 后重试。
- 提示词验收失败：将失败断言转成可复现最小输入，优先本地改代码修复并重新走整条交付链路，禁止只口头判定“应该可用”。
