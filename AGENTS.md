# Agent Notes

- If a change touches runtime backend code, shared runtime types, console IPC, or managed env keys used by `koishi.yml` through `./dist/plugins/**`, verify with `pnpm build` before handing it off. `pnpm console:build` is only enough for frontend-only console changes.
