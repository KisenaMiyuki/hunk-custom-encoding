# hunk-custom-encoding

 **[English](./README.md)** · 中文

[Hunk](https://hunk.dev) Git 审查的按文件编码转码扩展:GBK、Big5、Shift-JIS 等非 UTF-8 仓库正常显示中文/日文,而不是乱码,且**完全不改动被审查的仓库**。

## 简介

扩展注册了一个 VCS 适配器(`hunk-custom-encoding`),逐位包装 Git:所有产出 patch 的 `git` 命令以**字节模式**运行,patch 内容按段转码为 UTF-8 后再交给 Hunk。纯 UTF-8 仓库与内置适配器逐字节一致;检测与解码只发生在审查过程中,工作区与索引永不改写。

## 安装

```bash
hunk extension install KisenaMiyuki/hunk-custom-encoding
```

清单钉住 `"hunk": { "apiVersion": 25 }` —— 更旧的 Hunk 二进制会带明确提示拒绝加载。`hunk --no-extensions` 可临时关闭(本批次的 Hunk 内置后端不受影响)。

## 使用

| 命令 | 状态 | 说明 |
| --- | --- | --- |
| `hunk diff` / `hunk diff --staged` | ✅ | 已跟踪变更,字节模式转码 |
| `hunk diff <ref>` / `<from> <to>` / 区间 | ✅ | 新侧为工作区时包含 untracked 文件 |
| `hunk show [ref]` | ✅ | 源读取钉在 `<id>^` ↔ `<id>`;root commit 旧侧降级 |
| `hunk stash show [ref]` | ✅ | 默认 `stash@{0}` |
| `hunk diff --watch` | ✅ | 签名由转码后文本构成——编码配置一改即触发重审 |
| `--color-moved` / `diff.colorMoved` | ✅ | ANSI 透传;git 的固定 moved 行配色已复刻 |
| `hunk log` | ❌ | 报"不支持" |
| `hunk patch <file>` | ⚠️ | 直接读文件的输入不经过 VCS 适配器——不转码 |

merge 提交审查(`diff --cc`)的双符号列内容行同样转码。

## 为什么不用 `.gitattributes working-tree-encoding`?

git 的原生方案在 **checkout 时改写文件**:工作区被重写、索引变动,不了解该属性的工具会看到不同字节。本扩展走只读路线:

- 不改工作区与索引——检测与解码按审查进行;
- 无需逐仓库设置;同一份配置覆盖你审查的所有旧编码仓库;
- 混合编码仓库可用逐文件 `overrides`,这是仓库级属性表达不了的。

如果你已经在用 `working-tree-encoding` 且工作良好,继续用即可——本扩展是替代方案,不是前置条件。

## 配置

```toml
# ~/.config/hunk/config.toml 或 .hunk/config.toml
[extension.hunk-custom-encoding]
encodings = ["gbk", "big5", "shift_jis"]   # 候选列表,顺序即优先级
# fallback = "gbk"                          # 默认值;候选全部失败后使用(latin1 是最终兜底)

[extension.hunk-custom-encoding.overrides]
"sjis.txt" = "shift_jis"          # 不含 "/" → 按文件名匹配(任意深度)
"src/legacy/**" = "gbk"           # 含 "/" → 按仓库相对路径整体匹配
```

每个内容段的检测顺序:`overrides` → BOM → 严格 UTF-8 直通 → 候选列表按序 → `fallback` → latin1(永不失败)。编码名按白名单校验并归一(`gbk`/`gb2312`/`gb18030` → `gbk`、`latin1` → `windows-1252`);未知名会以状态栏提示拒绝。

仓库配置**逐键覆盖**用户配置——被审查的仓库可以调整本扩展的设置。这是 Hunk 的正常工作流;本扩展只用配置承载编码名,绝不用于任何 exec 相邻的决策,非法值也不会进入解码器。

**CJK 歧义**:Shift-JIS 与 GBK 共享大量字节序列。默认候选顺序下,Shift-JIS 文件通常会被解成 GBK——请用 `overrides` 钉住这类文件,或调整 `encodings` 顺序。

## 已知局限

- 检测是逐段启发式,不是保证——混合编码仓库请用 `overrides`。
- 二进制文件、子模块、UTF-16 内容原样透传(git 本就把它们判为二进制)。
- 超过 2 万变更行或 1 MB 的文件以统计信息跳过,不渲染 diff(与内置同门槛)。
- combined(`diff --cc`)段内容会转码,但 merge 提交的 `hunk show` 在非 TTY 静态模式下不渲染——请在交互 TUI 中审查。
- `hunk patch <file>` 完全绕过 VCS 适配器,patch 文件不会被转码。

## 开发

```bash
bun install          # 无运行时依赖;类型已 vendored
bun run test         # bun test test/ —— 163 用例,含 fixture 仓库集成测试
bunx tsc --noEmit    # 除 bun-init 模板 examples/ 外零报错
```

`types/hunkdiff-extension/` vendored 了钉住宿主 API(v25)的官方类型与运行时;`test/runtime.ts` 在真实宿主之外把 `hunkdiff/extension` 映射过去。fixture 仓库(`test/fixtures.ts`)提交的是精确的旧编码字节,每个解码结果都被钉死。

## 环境备注:bun 全局更新的部分替换问题

`bun add -g hunkdiff` 升级时可能只替换 `package.json` 等文件,不替换硬链接的预编译二进制(现象:包显示 0.22.0 但 `hunk --version` 报 0.21.1、加载扩展报 API v16),也不会刷新 optional/peer 依赖(如 `@opentui/core` 停在旧版导致 `Symbol "createEmbeddedTerminal" not found`)。遇到时彻底重装:

```bash
bun remove -g hunkdiff && rm -rf ~/.bun/install/global/node_modules/hunkdiff-windows-x64* && bun add -g hunkdiff
```

详情见 `docs/custom-encoding-implementation-plan.md` 的"宿主环境要求"一节。
