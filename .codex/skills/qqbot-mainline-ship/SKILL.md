---
name: qqbot-mainline-ship
description: Submit and ship the qqbot repository through its mainline workflow by delegating execution to a fresh independent Codex agent. Use when Codex needs to triage the full workspace, prepare a modification summary for handoff, decide submit vs ignore for every changed file, preserve file-coherent atomic commit boundaries, run local validation and behavior probes, report probe input/output, push `main`, watch GitHub `CI` and `Deploy`, inspect server Koishi logs, summarize warnings, and keep iterating on verified failures until deployment is clean.
---

# QQBot Mainline Ship

Follow this skill only for the `qqbot` repository at `/home/kkkzbh/code/qqbot`.

## Execution Model

- Do not execute this workflow entirely inside the current agent.
- Before any git mutation, local validation, or deploy action, spawn a fresh independent Codex agent to perform the ship workflow.
- Create that agent with no inherited thread context when the platform supports it. Pass only the minimum execution context needed for the task:
  - repository path: `/home/kkkzbh/code/qqbot`
  - the repo `AGENTS.md` constraints
  - this skill path
  - the current ship request
  - a structured modification summary
- The parent agent acts as coordinator and reviewer:
  - build the handoff package
  - launch the independent agent
  - wait for the independent agent's result
  - review whether the result satisfies this skill's contract
  - surface the final report to the user
- If the environment cannot spawn an independent agent, stop and report that this skill is blocked rather than silently falling back to in-thread execution.

## Modification Summary Contract

Before launching the independent agent, prepare a concise handoff summary that helps it understand the current change without leaking unnecessary conversation history.

Include:

- `Goal`: what this ship attempt is trying to change or deliver.
- `Change scope`: the features, fixes, or refactors expected to ship.
- `Touched files`: the files currently changed, grouped by likely semantic area.
- `Key behavior targets`: the behaviors that must hold after the change.
- `Known risks`: architecture-sensitive areas, linked packages, env surfaces, deploy-sensitive paths, or server/runtime concerns.
- `Validation focus`: the tests, smoke cases, and probe expectations that matter most for this change.
- `Open evidence`: any known failing test, bad probe result, CI failure, deploy failure, or Koishi log signature already observed.

Keep the summary factual and compact. Prefer diff-backed statements and observed failures over speculation.

## Workflow

1. Inspect the whole worktree before touching git state.
2. Build the modification summary for handoff.
3. Launch the independent agent with the minimum required execution context.
4. Have the independent agent decide `submit` or `ignore` for every tracked and untracked file.
5. Have the independent agent build a file-coherent commit plan.
6. Have the independent agent run all local gates before the first formal commit.
7. Have the independent agent probe model behavior and report the exact observed output.
8. If behavior is wrong, have the independent agent diagnose with verifiable evidence, fix code, and rerun from local gates.
9. Only when local validation is green, have the independent agent create the commit and push `main`.
10. Have the independent agent watch GitHub Actions until `CI` and `Deploy` settle.
11. Have the independent agent inspect server Koishi logs. If any `Error` remains, return to the fix loop.

## Commit Boundary Rules

- Treat the entire worktree as the review surface. Do not ignore unrelated changes silently.
- Explicitly classify every file as `submit` or `ignore` before staging.
- Preserve file coherence. Do not use partial staging or hunk splitting to place one file into multiple semantic changesets.
- Use the professional rule of file-level atomicity: if a file contains edits for concerns A and B, either refactor so each concern lives in its own file-coherent state, or widen the commit scope so the file is committed once. Never leave one physical file represented by multiple staged states.
- Prefer the smallest semantically complete commit set, but not at the cost of splitting a shared file.
- If environment-variable surface changes, treat `.env.example`, `.env.server.example`, `.env.local`, and `.env.server` as a coherence set and verify which members must ship together.
- Before the first push, delay the formal commit until all local gates and probe checks pass.
- After the first push, do not rewrite remote history and do not use `force-with-lease`. If later fixes are required, add follow-up commits and state that the single-commit invariant no longer applies post-push.

## Local Gates

Run these commands in order from `/home/kkkzbh/code/qqbot`:

```bash
pnpm chatluna:build
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:start
pnpm smoke:chat
```

- Do not skip a later gate because an earlier manual spot-check looked good.
- Treat failures as evidence, not as prompts to guess.
- `pnpm smoke:chat` is the required probe summary source because it prints the input prompt, the final visible output summary, and pass/fail.

## Probe Reporting

When reporting behavior, include all of the following for each decisive probe case:

- `Input`: the exact prompt sent to the bot.
- `Observed behavior`: the final visible reply or reply type seen by the probe.
- `Expected match`: whether the observed behavior satisfies the target behavior.

Keep this report concrete. Quote the actual probe-visible output instead of paraphrasing it away.

## Failure Handling

If probe behavior, tests, GitHub Actions, or server logs do not match expectations:

- Do not speculate.
- Reproduce with deterministic commands such as `pnpm smoke:chat`, targeted `pnpm test -- <file>`, startup smoke, workflow logs from `gh`, or Koishi logs from `journalctl`.
- Identify a cause that is backed by logs, tests, traces, or code-path inspection.
- Fix the code path that creates the wrong behavior. Do not paper over model failures with large manual cleanup or output-scrubbing layers.
- Rerun the affected local gates and then rerun the full probe path.
- Report:
  - the non-expected behavior
  - the evidence-backed cause
  - the fix method
  - the cost or tradeoff introduced by that fix

## Push And Deploy

- This skill only completes the ship workflow on branch `main`.
- If the current branch is not `main`, stop before push/deploy and report that release preconditions are not met.
- Once local gates and probe reporting are green, create the formal commit and push `main`.
- After pushing, watch GitHub Actions with `gh`. Track both workflows until completion:

```bash
gh run list --workflow ci.yml --branch main --limit 1
gh run watch <ci-run-id> --exit-status
gh run list --workflow deploy.yml --branch main --limit 1
gh run watch <deploy-run-id> --exit-status
```

- Resolve each run id from `gh run list --workflow <workflow> --branch main --limit 1 --json databaseId,status,conclusion,url`.
- If `CI` fails, inspect the failed run with `gh run view <run-id> --log` and re-enter the verified fix loop.
- If `Deploy` fails, inspect the failed run with `gh run view <run-id> --log` and re-enter the verified fix loop.

## Server Verification

After `Deploy` succeeds, inspect the server through the established `bot` SSH entrypoint.

Primary checks:

```bash
ssh -o ClearAllForwardings=yes bot 'systemctl --user status qqbot.target qqbot-stack.service qqbot-koishi.service'
ssh -o ClearAllForwardings=yes bot 'journalctl --user -u qqbot-koishi.service -n 200 --no-pager'
```

- Treat any `Error` in Koishi logs as a failed ship. Return to the local fix loop, rerun local gates and probes, push again, rewatch Actions, and recheck server logs.
- Always summarize all `warning` lines you find in the reviewed Koishi log window, even when deployment is otherwise successful.
- Do not declare success until the reviewed Koishi logs contain no unresolved `Error`.

## Output Contract

When using this skill, the final ship report should cover:

- the modification summary that was handed to the independent agent
- submitted files and ignored files
- the commit-boundary decision, especially any file-coherence tradeoffs
- the local gate results
- the probe report with exact input and observed output
- any non-expected behavior, its verified cause, the fix, and the introduced tradeoff
- the push target and whether `main` gating allowed release
- GitHub `CI` and `Deploy` outcomes
- server status summary
- all reviewed Koishi warnings
