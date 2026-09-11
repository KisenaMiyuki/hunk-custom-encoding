# hunk-custom-encoding

一个 Hunk 扩展：包装内置 Git VCS 适配器，在"字节 → 文本"的解码环节把非 UTF-8（GBK/Shift-JIS/Big5 等）patch 按文件分段重编码为 UTF-8，使 Hunk 能正常显示与交互非 UTF-8 仓库的 diff。对纯 UTF-8 仓库完全透明。

## Language

**patch 段 (patch segment)**:
一段以 `diff --git` 开头、属于单一文件的 patch 字节区间，是重编码的基本单元。
_Avoid_: 文件块、diff 块

**内容行 (content line)**:
段内 hunk 中以 `+` / `-` / 空格 / `\` 开头、承载文件实际内容的行，属于该文件的编码域。
_Avoid_: 数据行

**编码探测 (encoding probe)**:
对一段内容字节判定所用编码的决策链：overrides → BOM → 严格 UTF-8 校验 → 候选列表 → fallback → latin1 最终兜底。
_Avoid_: 猜编码、编码嗅探

**候选列表 (candidate list)**:
配置项 `encodings`，决定探测顺序；列表顺序即优先级，是 CJK 编码本质歧义的权威答案。
_Avoid_: 探测列表

**自产 diff (self-produced patch)**:
对 untracked 文件用 `git diff --no-index /dev/null <file>` 生成、再走同一转码管线的单文件 patch 文本，经 `extraFiles` 交给 Hunk。
_Avoid_: 合成 diff（与 Hunk 对 `untrackedPaths` 的原生合成区分开）

**比较基准 (comparison baseline)**:
working-tree-diff 的对照语义：无 range 时 `git diff`（index↔worktree），staged 时 `git diff --staged`，与内置 git 适配器逐位一致。
_Avoid_: diff 目标、diff 来源

**ASCII 快速路径 (fast path)**:
段内字节全部 < 0x80 时原样透传、零转码开销的捷径；纯 UTF-8 仓库因此完全透明。
_Avoid_: 旁路、短路（与颜色渲染的 fast path 混淆）