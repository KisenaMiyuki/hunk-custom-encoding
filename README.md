# hunk-custom-encoding

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.13. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## 环境备注:bun 全局更新的部分替换问题

`bun add -g hunkdiff` 升级时可能只替换 `package.json` 等文件,不替换硬链接的预编译二进制(现象:包显示 0.22.0 但 `hunk --version` 报 0.21.1、加载扩展报 API v16),也不会刷新 optional/peer 依赖(如 `@opentui/core` 停在旧版导致 `Symbol "createEmbeddedTerminal" not found`)。遇到时彻底重装:

```bash
bun remove -g hunkdiff && rm -rf ~/.bun/install/global/node_modules/hunkdiff-windows-x64* && bun add -g hunkdiff
```

详情见 `docs/custom-encoding-implementation-plan.md` 的"宿主环境要求"一节。
