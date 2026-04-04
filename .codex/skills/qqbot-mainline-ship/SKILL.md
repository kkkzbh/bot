---
name: qqbot-mainline-ship
description: Quickly submit and ship the qqbot repository through its mainline workflow. Use when Codex needs to review the current worktree, decide submit vs ignore for every file, keep file-coherent atomic commits, run low-cost checks related to the change, use a minimal behavior probe when needed, push `main`, watch GitHub `CI` and `Deploy`, inspect server Koishi logs, and fix verified problems without repeatedly running unnecessary heavy tests.
---

# QQBot Mainline Ship

只在 `/home/kkkzbh/code/qqbot` 使用这个 skill。

## Workflow

1. 先看整个 worktree，明确哪些文件提交，哪些文件忽略。
2. 保持文件级原子提交，不要把同一个文件拆成多个 staged 状态。
3. 先跑低成本、和改动直接相关的验证。
4. 如果是模型或回复行为改动，先跑一个最小必要的 probe。
5. 只有在证据表明影响面更大时，才补更重的检查。
6. 本地验证通过后，在 `main` 上提交、push、看 CI/Deploy、看服务器日志。

## Commit Rules

- 不要静默忽略无关改动，先明确 `submit` 或 `ignore`。
- 不要拆同一个文件的多个状态。
- 如果一个文件同时承载两个改动，就重构边界或扩大提交范围，不要靠 partial staging 硬拆。
- 第一次 push 前尽量保持为一个正式提交。
- push 后不要改写远端历史，不要用 `force-with-lease`。
- push 后如果又发现问题，可以追加修正提交。

## Local Validation

默认先跑：

```bash
pnpm typecheck
```

然后按改动补最小必要验证：

- 有直接相关测试时，优先跑相关 `pnpm test -- <files...>`。
- 是模型、回复、提示词、发送行为改动时，优先跑一个最小必要的 probe：

```bash
bash ./scripts/probe-local-bot.sh "<prompt>"
```

- 只有在需要确认启动、插件加载、env 接线、runtime 启动链路时，才跑：

```bash
pnpm smoke:start
```

- 只有在定向 probe 不够、改动明显很广、或者问题根因仍不清楚时，才跑：

```bash
pnpm smoke:chat
```

- 在 `main` 上正式 push 前跑一次：

```bash
pnpm build
```

默认不要为了一个小修复反复跑全量 `pnpm test` 或全量 `pnpm smoke:chat`。

## Retest Rule

- 修复后先重跑刚才失败的那个测试或 probe。
- 如果它已经通过，就不要自动补跑一堆更贵的检查。
- 只有出现新证据说明影响面更大，才扩大验证范围。

## Fix Rule

- probe 不符合预期时，先找最直接可验证的原因，不要乱猜。
- CI 或 Deploy 失败时，先看日志，再修，再推。
- 服务器 Koishi 日志有 `Error` 时，修掉后重新走最小必要验证。
- warning 要汇报，但不要围绕 warning 设计很多特殊流程。

## Push And Deploy

- 只在 `main` 上完成 push/deploy 闭环。
- 如果当前分支不是 `main`，就在 push 前停止并说明不满足发布条件。
- push 后用 `gh` 跟踪 `CI` 和 `Deploy`：

```bash
gh run list --workflow ci.yml --branch main --limit 1
gh run watch <ci-run-id> --exit-status
gh run list --workflow deploy.yml --branch main --limit 1
gh run watch <deploy-run-id> --exit-status
```

- 需要时用 `gh run view <run-id> --log` 看失败日志。

## Server Check

`Deploy` 成功后检查：

```bash
ssh -o ClearAllForwardings=yes bot 'systemctl --user status qqbot.target qqbot-stack.service qqbot-koishi.service'
ssh -o ClearAllForwardings=yes bot 'journalctl --user -u qqbot-koishi.service -n 200 --no-pager'
```

- 看到 `Error` 就继续修，不要宣布完成。
- 汇报看到的 warning。

## Report

最终汇报只需要覆盖这些内容：

- 提交了哪些文件，忽略了哪些文件
- 本次用了哪些验证
- 为什么跳过了哪些重测试
- probe 的输入和实际输出
- 遇到的错误、确认过的原因、修复方式
- `CI` / `Deploy` 结果
- 服务器状态和 warning
