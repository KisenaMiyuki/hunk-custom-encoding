# hunk-custom-encoding 实现计划

> 目标：让 Hunk 能够正常读取并显示非 UTF-8 编码（如 GBK/GB2312、Shift-JIS、Big5 等）文件的 diff。
>
> 适用 API：`hunkdiff/extension`（本文写作时 `hunk.apiVersion === 25`）。

## 1. 背景与问题定义

Hunk 运行在 Bun 运行时之上，所有文本（子进程输出、文件读取、patch 解析）都按 **UTF-8** 解码。当被审查仓库中的文件以其他编码保存时：

- 底层 VCS（Git）在 `git diff` 时**原样输出文件的原始字节**，不做转码；
- Hunk 的 Git 适配器把这段字节流按 UTF-8 解码，非法字节序列变成 `U+FFFD` 替换符（�）；
- 于是 diff 中的 `+` / `-` / 上下文行显示为乱码，且**原始字节已经丢失，无法从显示结果逆推**。

典型场景：

- Windows 上的中文仓库（GBK/GB2312，VS 旧工程、老脚本、CSV、INI 等）；
- 日文仓库（Shift-JIS / EUC-JP）；
- 繁体中文仓库（Big5）；
- 混合编码仓库（新文件 UTF-8，遗留文件 GBK）。

### 1.1 为什么不能靠 `transformChangeset` 修复

`hunk.transformChangeset(fn)` 在 changeset 加载后、渲染前运行，看起来是最自然的位置。但它不可行：

- 每个 `file.metadata` 是"渲染器直接绘制用的已解析 diff"，文档明确要求**原样透传**；
- 乱码（替换符）此时已经存在于解析结果中，替换符不可逆，无法还原原始字节；
- 重建 `metadata` 等于重写 Hunk 内部的 diff 解析器，脆弱且违反 API 契约。

`transformChangeset` 只适合过滤/排序文件，不适合修复内容。**修复必须发生在"字节 → 文本"的解码环节。**

### 1.2 唯一的介入点：VCS 适配器

`hunk.registerVcsAdapter` 是扩展 API 中唯一能控制 `patchText`（patch 字节流 → 文本）和 `readFileSource`（精确文件源）的入口。因此本插件采用**包装 Git 的自定义 VCS 适配器**方案：

- 自己以二进制方式运行 git 命令，拿到原始字节；
- 按文件分段、探测编码、转码为 UTF-8；
- 把转码后的 UTF-8 文本交给 Hunk 解析渲染。

## 2. 被否决的备选方案（记录理由）

| 方案 | 否决理由 |
| --- | --- |
| `transformChangeset` 修文本 | 字节已丢失、metadata 不透明、重建解析器不可维护（见 1.1） |
| `registerFileView` 备用呈现 | file view 是**替换整个文件呈现**的宿主渲染路径，无法修复默认 raw diff 的乱码文本；且只在选中视图时生效 |
| `registerLineHighlighter` | 纯绘制层，只能改背景色，不能改文本 |
| `registerPane` 侧栏 | 不解决核心 diff 流的乱码 |
| 引导用户配置 `.gitattributes` `working-tree-encoding` | 这是 Git 侧的可行方案，但要求改仓库、按文件维护属性，且 `git diff` 之外的路径仍可能踩坑。作为**补充建议**写入 README，不作为本插件方案 |

## 3. 总体架构

目录结构（沿用现有 bun 工程，入口已由 `package.json` 的 `hunk.extensions` 声明）：

```text
hunk-custom-encoding/
  index.ts          # 入口：注册 VCS 适配器 + 读取配置
  src/
    git.ts          # git 命令执行（二进制输出、参数组装、错误翻译）
    transcode.ts    # 编码探测 + 字节→UTF-8 转码（纯函数，可单测）
    patch.ts        # diff 字节流分段、按段重编码（纯函数，可单测）
    config.ts       # [extension.hunk-custom-encoding] 配置解析与校验
  test/
    transcode.test.ts
    patch.test.ts
    git.integration.test.ts   # 需要 git，用 fixture 仓库
  fixtures/         # 各编码的样例文件与 fixture 仓库构建脚本
  README.md
```

依赖策略：**零运行时依赖**。WHATWG `TextDecoder` 在 Bun 中原生支持 `gbk`、`big5`、`shift_jis`、`euc-jp`、`euc-kr`、`iso-8859-*` 等 legacy 编码，无需 `iconv-lite`。

### 3.1 模块职责

- **`git.ts`**：封装 `Bun.spawn` 异步执行 git，`stdout` 按字节（`Uint8Array`）收集；统一传递 `ctx.signal` 取消；把 git 退出码翻译成 `HunkExtensionUserError`。
- **`transcode.ts`**：`detectEncoding(bytes, path, config): Encoding` 与 `transcode(bytes, encoding): string`。纯函数。
- **`patch.ts`**：`transcodePatch(bytes, ctx): string`。按 `diff --git` 分段 → 每段探测编码 → 逐行转码 → 重组为完整 UTF-8 patch 文本。
- **`config.ts`**：解析 `hunk.config`（`encodings` 候选列表、`overrides` 路径映射、`fallback`），做白名单校验。

## 4. 核心算法：diff 字节流的分段重编码

```
原始 patch 字节流
  │ 按行扫描，遇到 /^diff --git / 开新段
  ▼
段 A（文件 a.txt）    段 B（文件 b.csv）    ...
  │ 提取 +++ b/<path>   │
  │ 判断该段是否二进制   │  → 二进制段原样透传（不转码）
  │ 探测编码            │
  ▼
按行转码：
  · 第一个 @@ 之前：头部行（diff --git / index / --- / +++ / rename / mode）
      → 按 UTF-8 解码（git 路径由 core.quotepath=false 保证为 UTF-8 字节）
  · @@ 行本身：ASCII，恒等
  · 内容行（+ / - / 空格前缀 / \ 续行标记）：
      → 按该文件探测出的编码解码
  ▼
重组 → UTF-8 patchText
```

要点：

1. **路径与内容分开解码**。`git diff` 的路径字节是 UTF-8（需显式 `-c core.quotepath=false`），若整段按 GBK 解码会连路径一起变乱码。所以头部行固定按 UTF-8，只有 hunk 内容行按文件编码。
2. **逐行而不是整段解码**。只有 `+`/`-`/` 空格` 前缀的内容行才属于该文件的编码域；`\ No newline at end of file` 等 ASCII 标记恒等保留。
3. **二进制段跳过**。`Binary files a/... and b/... differ` 与 `GIT binary patch` 段不做任何转码，Hunk 按既有 binary 占位渲染。
4. **纯 ASCII 快速路径**。某段字节全部 < 0x80 时直接透传，零开销。
5. **子模块段**（`Subproject commit ...`）与**纯 mode 变更段**（`old mode`/`new mode`）为 ASCII，自然走快速路径。

## 5. 编码探测策略

优先级从高到低：

1. **路径覆盖（overrides）**：`hunk.config.overrides` 里的 glob/精确路径 → 指定编码。最可靠，用户对已知遗留文件直接指定。
2. **BOM 探测**：`EF BB BF`（UTF-8）、`FF FE`（UTF-16LE）、`FE FF`（UTF-16BE）。
3. **严格 UTF-8 校验**：`new TextDecoder("utf-8", { fatal: true })` 不抛错 → 判定 UTF-8，直通。
4. **候选编码列表**：按 `hunk.config.encodings` 的顺序逐个尝试（fatal 模式），第一个能完整解码的胜出。
5. **兜底**：`hunk.config.fallback`，默认 `"gbk"`。

### 5.1 已知局限（必须写进文档）

- **CJK 编码存在本质歧义**：GBK / Big5 / Shift-JIS 的字节范围大量重叠，很多字节序列在多个编码下都能"合法"解码。单靠启发式无法可靠区分，**配置（overrides/encodings 顺序）是权威答案**。
- 可选的增强（M4 之后再评估）：对候选编码按"解码后罕见字符/控制符数量"打分，作为排序辅助；但不替代配置。
- 探测基于该文件在 patch 中出现的**内容字节**；若某文件仅 mode 变更、无 hunk，则无需探测。

## 6. VCS 适配器实现

```ts
import { HUNK_VCS_DETECTION_BASELINE_PRIORITY } from "hunkdiff/extension";

hunk.registerVcsAdapter({
  id: "hunk-custom-encoding",           // 非保留 id，避让 git/jj/sl/hunk
  name: "Git (custom encoding)",
  detectionPriority: HUNK_VCS_DETECTION_BASELINE_PRIORITY + 10,
  detect: async (cwd) => {
    // 与内置 git 相同的探测：git rev-parse --is-inside-work-tree
    // 返回 { id: "hunk-custom-encoding", repoRoot }
  },
  operations: {
    "working-tree-diff": { ... },   // M2 核心
    "revision-show": { ... },       // M3
    "stash-show": { ... },          // M3
  },
  watchSignature: ...,              // M3（apiVersion 25，Promise 签名）
  history: undefined,               // 不实现 → hunk log 报"不支持"，避免半成品
});
```

> **注意**：适配器一旦 detect 命中，就**完全接管**该仓库的全部 VCS 操作。优先级高于内置 git（baseline + 10），因此所有 git 仓库都会走本适配器。这要求我们把内置 git 适配器的行为忠实复刻，见第 8 节风险清单。

### 6.1 `working-tree-diff`（M2 核心）

```
load(input, ctx):
  1. 确定比较基准（与内置 git 适配器一致，见风险 R1）
     通常为：git diff HEAD --no-color（工作区 + 暂存 vs HEAD）
  2. 用 git.ts 以字节模式执行，拿到 Uint8Array
  3. patch.ts 分段重编码 → patchText
  4. untracked 文件（git ls-files --others --exclude-standard -z）
     → 走 extraFiles: [{ kind: "patch", path, patchText: 自产转码 diff, isUntracked: true }]
     ⚠ 不用 untrackedPaths：Hunk 合成 added-file diff 时自行读工作区文件，
       会再次按 UTF-8 解码，乱码复现；自产 diff 才能保证转码
  5. 返回 { repoRoot, sourceLabel, title, patchText, extraFiles, sourceCacheKey }
```

`input.options` 需要透传的开关：

- `colorMoved`：M2 暂不支持（见 6.5），默认 `--no-color`；
- `excludeUntracked`：为 true 时跳过第 4 步。

### 6.2 `readFileSource`（M2 核心，精确文件源）

```ts
readFileSource: async ({ path, previousPath, changeType, side }, ctx) => {
  // side === "old"：git show <基准rev>:<previousPath ?? path> → 字节 → 转码
  // side === "new"：changeType === "deleted" ? null : 读工作区文件字节 → 转码
  // 二进制/不存在 → null；超大文件 → { kind: "too-large", maxBytes }
}
```

- 在 `load` 时钉住基准 rev（如 `HEAD` 的完整 sha）并闭包引用，避免二次请求时 ref 移动；
- 探测复用 `transcode.ts`，逐文件独立判定编码；
- 返回 UTF-8 字符串，供 Hunk 做上下文展开、行内高亮与 word-diff；
- `sourceCacheKey`：使用 `${oldRev}:${newRev}`，稳定则复用高亮缓存。

### 6.3 `revision-show`（M3）

`git show --no-color --format= <rev>` 以字节执行 → 同一分段重编码管线。供 `hunk show <rev>` 使用。

### 6.4 `stash-show`（M3）

`git stash show -p <stash>` 以字节执行 → 同一管线。

### 6.5 `watch` 与 `colorMoved`（M3）

- `watchSignature(input, ctx)`：`git status --porcelain` + `git rev-parse HEAD` 的字节摘要，Promise 返回（apiVersion 25）。比 `watchPlan` 简单可靠，代价是每 tick 一次子进程，可接受。
- `colorMoved`：git 的 `--color-moved` 输出把 ANSI 转义包裹在 `+`/`-` 前缀外，会破坏按行分类逻辑。M2 一律 `--no-color`（丢失 moved-line 着色，但不影响正确性）；M3 再支持：先剥 ANSI、按前缀分类、转码后再把 moved 标记还原，或评估直接透传 colored 段 + 仅对内容字节做局部转码。

### 6.6 不支持面

- `history`（`hunk log` 交互）：不实现，Hunk 对未提供的 capability 报"不支持"，不会崩溃。避免为了 log 复刻整套提交图遍历。
- 纯 patch 输入（`hunk patch foo.diff` 读磁盘文件）：不经 VCS 适配器，不在本插件范围，写入 README 说明。

## 7. 配置设计

```toml
# ~/.config/hunk/config.toml 或 .hunk/config.toml
[extension.hunk-custom-encoding]
encodings = ["gbk", "big5", "shift_jis"]          # 候选列表，顺序即优先级
fallback = "gbk"                                   # 全部失败时的兜底
overrides = { "legacy/**/*.txt" = "gbk", "*.csv" = "gbk" }
```

`config.ts` 校验：

- `encodings` 必须是白名单内的编码名（`new TextDecoder(name)` 能构造才接受），去重、限长；
- `overrides` 的 key 限制为 Hunk 文档同款 glob 语法（basename / path 两种 target），value 同样白名单；
- 非法值忽略并 `ctx.notify` 提示，不回退整个扩展。

**信任说明**：`hunk.config` 会被仓库级 config 覆盖（不可信输入）。编码选择只影响**显示**，不涉及命令执行/路径拼接，风险可控；但文档中仍需声明，避免未来把编码名用于拼路径等 exec 决策。

## 8. 兼容性、风险与待确认事项

### R1（必须先做）：复刻内置 git 适配器的命令行为

接管 git 仓库后，`working-tree-diff` 的 diff 语义必须与内置 git 适配器一致，否则用户看到的 diff 内容会"变了"。需要在 Hunk 源码仓库对照 `packages/hunk-git/src/` 确认：

- 比较基准：`git diff HEAD`（含 staged+unstaged）还是 `git diff` + `git diff --cached`？
- 是否传 `--find-renames`、`--no-textconv`、`--binary`、`-z` 等；
- untracked 列表命令与 `--exclude-standard` 行为；
- 大文件跳过阈值与 `too-large` 的 `maxBytes` 口径。

### R2（先验证再动手）：确认乱码产生的确切环节

在写代码前，先构造一个 GBK 仓库，用 `hunk diff` 观察乱码形态，确认：
- 是 `U+FFFD` 替换符（字节丢失，必须走适配器方案）；
- 还是被某解码器按 Latin-1/其它编码误解（则可能只需换解码策略）。
本计划按"替换符、字节丢失"假设编写，若验证结果不同需回头调整。

### R3：Windows 特有问题

- git 命令参数中的路径需要正确的引号/`--` 分隔，避免 `git show <rev>:<path>` 被 shell 语义影响（用 `Bun.spawn` 数组参数，不经 shell）；
- `-z`（NUL 分隔）输出按字节处理，避免路径含换行；
- 继承内置适配器对 Windows 换行/CRLF 的处理。

### R4：纯 UTF-8 仓库的零影响

UTF-8 段走严格校验直通，快速路径保证无额外开销、无行为差异。适配器对 UTF-8 仓库而言是"透明的 git"，唯一差异是 `--no-color` 的 moved-line 着色（M3 补齐）。

### R5：性能

- 全程单次线性扫描，无重复解码；
- 解码器按编码缓存复用（`TextDecoder` 实例池）；
- 大 patch（> 若干 MiB）沿用 github-pr 示例的字节上限读法（`readBoundedResponse` 风格），防止内存爆炸；
- `sourceCacheKey` 让精确源的高亮结果可跨 reload 复用。

### 其他待确认

- `package.json` 当前存在 JSON 语法错误（`"hunk"` 块后缺逗号），会阻断 `bun install` 与发现加载，**开工第一件事修掉**，并补 `"hunk": { "extensions": [...], "apiVersion": 25 }` 声明。
- 本工作区无 `hunkdiff/extension` 类型包，开发期需要 `hunk` 本体或从文档手写类型桩；确认 `hunk.dev` 是否提供发布类型。

## 9. 测试计划

### 9.1 单测（`bun test`，纯函数）

- `transcode.test.ts`：
  - 各编码样例字节 → 正确 UTF-8 文本（GBK 中文、Shift-JIS 日文、Big5 繁中、UTF-8 直通、UTF-8 BOM、UTF-16 BOM）；
  - 非法序列 fatal 抛错 → 回退下一候选；
  - overrides 优先、encodings 顺序生效、fallback 兜底；
  - 纯 ASCII 快速路径。
- `patch.test.ts`：
  - 混合仓库 patch：UTF-8 文件 + GBK 文件 + 二进制段 + rename 段 + mode-only 段 → 只转内容行、路径不变乱码；
  - `\ No newline at end of file` 保留；
  - 子模块段透传。

### 9.2 集成测试（fixture git 仓库）

- `fixtures/` 用脚本构建一个真 git 仓库：GBK / Shift-JIS / Big5 / UTF-8 / UTF-8-BOM / 二进制文件各有改动，含 untracked 文件；
- 断言：`hunk diff --extension ./index.ts <fixture>` 的 PTY 输出中不再出现 `U+FFFD`，中文/日文/繁中正确显示；
- 反向断言：纯 UTF-8 仓库的输出与 `--no-extensions` 基线一致（diff 语义无回归）。

### 9.3 手工验证清单

- `hunk diff`（工作区）、`hunk show`（revision-show）、stash、untracked 文件、`--watch` 热重载；
- 大文件 `too-large` 占位；
- Windows 路径含空格/中文的仓库。

## 10. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M0 | 修 package.json、补 apiVersion、搭类型桩 | `bun install` 通过，扩展能被发现 |
| M1 | `transcode.ts` + `patch.ts` + 单测 | 纯函数单测全绿 |
| M2 | `git.ts` + `working-tree-diff` 适配器 + `readFileSource` + untracked(extraFiles) | GBK fixture 仓库 `hunk diff` 无乱码；UTF-8 仓库无回归 |
| M3 | `revision-show` / `stash-show` / `watchSignature` / `colorMoved` | 对应命令验证通过 |
| M4 | README（含 `.gitattributes working-tree-encoding` 补充方案、信任说明、配置文档）、发布（`hunk-extension` topic） | 文档齐备、可安装 |

## 11. 结论

本插件通过一个包装 Git 的 VCS 适配器，在"字节 → 文本"解码环节介入：以二进制方式运行 git、按文件分段、BOM/UTF-8 严格校验/配置驱动三重探测编码、只对 hunk 内容行转码为 UTF-8，并配套 `readFileSource` 精确文件源与 untracked 自产 diff。它不需要修改被审查仓库，不引入运行时依赖，且对纯 UTF-8 仓库完全透明。核心风险在于接管 git 仓库后必须与内置 git 适配器的 diff 语义保持一致（R1），因此 M0/R1/R2 的验证是开工前提。