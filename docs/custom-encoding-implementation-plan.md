# hunk-custom-encoding 实现计划

> 目标：让 Hunk 能够正常读取并显示非 UTF-8 编码（如 GBK/GB2312、Shift-JIS、Big5 等）文件的 diff。
>
> 适用 API：`hunkdiff/extension`（本文写作时 `hunk.apiVersion === 25`）。
>
> 配套文档：术语表见 `CONTEXT.md`；核心决策与理由见 `docs/adr/0001`–`0004`。

## 0. 决策总览（grill-with-docs 2026-09 已敲定）

本计划经两轮设计树访谈后定稿，14 个决策点全部确定：

| # | 决策 | 结论 |
| --- | --- | --- |
| Q1 | working-tree 比较基准 | **复刻内置**：无 range → `git diff`（index↔worktree）；staged → `--staged`（不是 `git diff HEAD`） |
| Q2 | git 路径引用 | **`-c core.quotePath=true`**（非 ASCII 路径八进制转义），跟随内置 |
| Q3 | untracked 自产 diff | **`git diff --no-index /dev/null <file>`** → 同一转码管线（已验证 Windows 可用），经 `extraFiles` 返回 |
| Q4 | colorMoved（M3） | **透传 ANSI**：复刻内置 `--color=always --color-moved=<mode>`，内容行整行按文件编码解码（legacy 编码 ASCII 兼容，escape 天然无损） |
| Q5 | watchSignature（M3） | **转码后 patch 文本 + untracked stat 签名**（`path:size:mtime:ino`），跟随内置 |
| Q6 | history（`hunk log`） | **v1 不做**，报"不支持"，记为未来工作 |
| Q7 | 集成测试 | **adapter 层 in-process**：直接调用 `load()`/`readFileSource()` 断言；PTY e2e 降为手工清单 |
| Q8 | 探测兜底 | **双级兜底**：候选失败 → `fallback`（默认 gbk）→ `latin1`（永不抛错，保证有输出） |
| Q9 | readFileSource 探测 | **按 (path, side) 独立探测**；`sourceCacheKey` 追加所用编码 |
| Q10 | `diff --cc`（merge） | **v1 识别但原样透传**（不转码），记为 M4+ 增强 |
| Q11 | overrides glob target | **斜杠启发式**：glob 含 `/` → path target，否则 → basename |
| Q12 | 编码白名单 | **硬编码 legacy 白名单 + 运行时 `new TextDecoder` 构造验证**（基于 Bun 1.3.13 实测支持集） |
| Q13 | range/rangeEndpoints | **M2 完整复刻**：range 透传 + `from..to` + `A...B` merge-base 端点解析（适配器全面接管，这些命令必须可用） |
| Q14 | 发布目标 | **保持 `private: true`**，本地/团队使用；发布与否后续再定 |

## 1. 背景与问题定义

Hunk 运行在 Bun 运行时之上，所有文本（子进程输出、文件读取、patch 解析）都按 **UTF-8** 解码。当被审查仓库中的文件以其他编码保存时：

- 底层 VCS（Git）在 `git diff` 时**原样输出文件的原始字节**，不做转码（已本地实测确认）；
- Hunk 的 Git 适配器把这段字节流按 UTF-8 解码——对照源码确认是 `Response.text()` / `Buffer.toString("utf8")`（UTF-8 **非 fatal**），非法字节序列变成 `U+FFFD` 替换符（�）；
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

`hunk.registerVcsAdapter` 是扩展 API 中唯一能控制 `patchText`（patch 字节流 → 文本）和 `readFileSource`（精确文件源）的入口。因此本插件采用**包装 Git 的自定义 VCS 适配器**方案（ADR-0001）：

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
| `untrackedPaths`（让宿主合成 untracked diff） | 宿主按 UTF-8 重读工作区文件，非 UTF-8 文件乱码复现。改用 `extraFiles` 自产 diff（ADR-0002） |

## 3. 总体架构

目录结构（沿用现有 bun 工程，入口已由 `package.json` 的 `hunk.extensions` 声明）：

```text
hunk-custom-encoding/
  index.ts          # 入口：注册 VCS 适配器 + 读取配置
  CONTEXT.md        # 术语表
  docs/adr/         # 决策记录 0001-0004
  src/
    git.ts          # git 命令执行（二进制输出、参数组装、错误翻译）
    transcode.ts    # 编码探测 + 字节→UTF-8 转码（纯函数，可单测）
    patch.ts        # diff 字节流分段、按段重编码（纯函数，可单测）
    config.ts       # [extension.hunk-custom-encoding] 配置解析与校验
  test/
    transcode.test.ts
    patch.test.ts
    adapter.integration.test.ts   # 需要 git，直接调用 load()/readFileSource()
  fixtures/         # 各编码的样例文件与 fixture 仓库构建脚本
  README.md
```

依赖策略：**零运行时依赖**（ADR-0003）。WHATWG `TextDecoder` 在 Bun 中原生支持 `gbk`、`big5`、`shift_jis`、`euc-jp`、`euc-kr`、`iso-8859-*`（部分）、`windows-125x`（部分）等 legacy 编码（已在 Bun 1.3.13 实测），无需 `iconv-lite`。

### 3.1 模块职责

- **`git.ts`**：封装 `Bun.spawn` 异步执行 git，`stdout` 按字节（`Uint8Array`）收集；统一传递 `ctx.signal` 取消；把 git 退出码翻译成 `HunkExtensionUserError`。命令组装按内置 git 适配器逐位复刻（ADR-0004）：统一的 `-c` prefix 归一化参数、`--no-ext-diff --find-renames --no-color`、`--staged`、range、pathspecs、`:(exclude)` 大文件排除；untracked 用 `git diff --no-index /dev/null <file>`。
- **`transcode.ts`**：`detectEncoding(bytes, path, config): Encoding` 与 `transcode(bytes, encoding): string`。纯函数。
- **`patch.ts`**：`transcodePatch(bytes, ctx): string`。按 `diff --git` / `diff --cc` 分段 → 每段探测编码 → 逐内容行转码 → 重组为完整 UTF-8 patch 文本。
- **`config.ts`**：解析 `hunk.config`（`encodings` 候选列表、`overrides` 路径映射、`fallback`），做白名单校验与 glob 归一化。

## 4. 核心算法：diff 字节流的分段重编码

```
原始 patch 字节流
  │ 按行扫描，遇到 /^diff --git / 开新段（普通段）
  │         遇到 /^diff --cc / 或 /^diff --combined / → combined 段（v1 原样透传，见 4.6）
  ▼
段 A（文件 a.txt）    段 B（文件 b.csv）    ...
  │ 提取 +++ b/<path>   │
  │ 判断该段是否二进制   │  → 二进制段原样透传（不转码）
  │ 探测编码            │
  ▼
按内容行转码：
  · 第一个 @@ 之前：头部行（diff --git / index / --- / +++ / rename / mode / Subproject）
      → 按 UTF-8 解码（core.quotePath=true 保证路径已八进制转义为纯 ASCII）
  · @@ 行本身：ASCII，恒等
  · 内容行（+ / - / 空格前缀 / \ 续行标记）：
      → 按该文件探测出的编码解码（整行解码；ANSI 转义因 ASCII 兼容天然无损）
  ▼
重组 → UTF-8 patchText
```

要点：

1. **路径与内容分开解码**。git 命令统一带 `-c core.quotePath=true`（内置同款，Q2/ADR-0004）：非 ASCII 路径在 patch 头部被八进制转义成纯 ASCII（`\345\222\214.txt`），因此头部行按 UTF-8 解码**恒安全**，与内置 git 适配器及 Hunk 解析器的行为完全一致。
2. **逐内容行而不是整段解码**。只有 `+`/`-`/` 空格` 前缀的内容行才属于该文件的编码域；`\ No newline at end of file` 等 ASCII 标记恒等保留。
3. **二进制段跳过**。`Binary files a/... and b/... differ` 与 `GIT binary patch` 段不做任何转码，Hunk 按既有 binary 占位渲染。
4. **纯 ASCII 快速路径**。某段字节全部 < 0x80 时直接透传，零开销。
5. **子模块段**（`Subproject commit ...`）与**纯 mode 变更段**（`old mode`/`new mode`）为 ASCII，自然走快速路径。
6. **combined 段（`diff --cc`/`diff --combined`）**：v1 识别但**原样透传不转码**（Q10）。merge commit 的 `hunk show` 场景少见，`@@@` 头与双前缀内容行的转码记为 M4+ 增强。
7. **colorMoved（M3）**：内容行可能是 `\x1b[36m+...\x1b[m` 形态。GBK/Big5/Shift-JIS/EUC-JP 全是 ASCII 兼容超集（单字节区 0x00-0x7F 恒等），**整行按文件编码解码时 ANSI 转义序列天然保持原样**，无需剥色/还原（Q4）。编码探测时跳过 `\x1b[...m` 序列再取内容字节。

## 5. 编码探测策略

优先级从高到低：

1. **路径覆盖（overrides）**：`hunk.config.overrides` 里的 glob → 指定编码。最可靠，用户对已知遗留文件直接指定。glob 语义沿用 Hunk `registerFileLanguage` 的规则（Bun shell 风格、大小写敏感、`/` 是 review-path 分隔符），**target 用斜杠启发式**（Q11）：glob 含 `/` → path target（匹配完整 review 路径），否则 → basename（任意深度匹配文件名）。同路径多条命中时取最长匹配。
2. **BOM 探测**：`EF BB BF`（UTF-8）、`FF FE`（UTF-16LE）、`FE FF`（UTF-16BE）。
3. **严格 UTF-8 校验**：`new TextDecoder("utf-8", { fatal: true })` 不抛错 → 判定 UTF-8，直通。
4. **候选编码列表**：按 `hunk.config.encodings` 的顺序逐个尝试（fatal 模式），第一个能完整解码的胜出。
5. **兜底**：`hunk.config.fallback`，默认 `"gbk"`。
6. **最终兜底**：`latin1`——永不抛错（每个字节都合法），保证转码一定有输出（Q8）。

白名单（Q12）：`config.ts` 维护一份**硬编码 legacy 编码名集合**（依据 Bun 1.3.13 实测支持集），值必须在白名单内**且** `new TextDecoder(name)` 能构造才接受，否则忽略并 `ctx.notify` 提示。白名单覆盖：`gbk`/`gb2312`/`gb18030`、`big5`、`shift_jis`、`euc-jp`、`euc-kr`、`iso-8859-1/6/7/8`、`windows-1252/1253/1255/1257`、`koi8-u`、`ibm866`/`cp866`、`latin1`。不开放 `utf-8`（严格校验已覆盖）与 `utf-16*`（git 判二进制，无内容行可转码）。

### 5.1 已知局限（必须写进文档）

- **CJK 编码存在本质歧义**：GBK / Big5 / Shift-JIS 的字节范围大量重叠（已实测：GBK 字节 `d6 d0 ce c4` 在 big5/shift_jis/euc-jp 下都能"合法"解码），很多字节序列在多个编码下都能"合法"解码。单靠启发式无法可靠区分，**配置（overrides/encodings 顺序）是权威答案**。
- **严格 UTF-8 校验排在候选列表之前**：一个恰好全部字节都合法 UTF-8 的 GBK 文件会被判为 UTF-8。概率低但非零，属固有歧义，文档声明"overrides 是权威"即可；不引入打分启发式（M4 之后再评估）。
- 探测基于该文件在 patch 中出现的**内容字节**；若某文件仅 mode 变更、无 hunk，则无需探测。
- **跨版本改编码的文件**（旧 GBK → 新 UTF-8）：`readFileSource` 按 (path, side) 独立探测，两侧各自判定（Q9）。

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
  history: undefined,               // 不实现 → hunk log 报"不支持"，避免半成品（Q6）
});
```

> **注意**：适配器一旦 detect 命中，就**完全接管**该仓库的全部 VCS 操作。优先级高于内置 git（baseline + 10），因此所有 git 仓库都会走本适配器。这要求我们把内置 git 适配器的行为**逐位复刻**（ADR-0004，已核实记录见 §8 R1）。

### 6.1 `working-tree-diff`（M2 核心）

```
load(input, ctx):
  1. 端点解析（复刻内置 resolveGitDiffEndpoints）：
       · 无 range 且非 staged  → old=index, new=worktree
       · staged（无 range）    → old=HEAD^{commit}(或 none, 未出生分支), new=index
       · range 单正 rev        → old=git-ref(rev), new=worktree
       · rangeEndpoints A..B   → old=git-ref(A), new=git-ref(B)
       · A...B                 → old=merge-base(A,B), new=git-ref(B)（M2 支持，Q13）
  2. numstat 预扫描（复刻内置）：
       git ... diff --no-ext-diff --find-renames --no-color --numstat -z [--staged] [range] [-- pathspecs]
       改动行数 >20000 或磁盘大小 >1MB 的文件 → 加入 :(exclude) 排除，
       并生成 extraFiles [{ kind:"skipped", path, reason:"too-large", stats }]
  3. 主 patch（字节模式执行，复刻内置 buildGitDiffArgs）：
       git -c core.quotePath=true -c diff.noprefix=false -c diff.mnemonicPrefix=false \
           -c diff.srcPrefix=a/ -c diff.dstPrefix=b/ \
           diff --no-ext-diff --find-renames --no-color [--staged] [<range>] [-- <pathspecs> ... :(exclude)...]
  4. patch.ts 分段重编码 → patchText
   5. untracked（gating 已对照内置源码核实 2026-09，`isWorkingTreeGitDiffInput`：**新侧为 worktree 时包含**——无 range，或 range 经 `git rev-parse --revs-only` 解析为恰一正 rev 且无负 rev（单 rev、`A..`）；staged / `A..B` / `A...B` / rangeEndpoints / `excludeUntracked` 时跳过；此外按内置 `isReviewableUntrackedPath` 过滤目录与目录符号链接）：
        git --no-optional-locks status --porcelain=v1 -z --untracked-files=all [-- <pathspecs>]
        解析 `?? ` 条目 → 逐个：大小 >1MB 或行数 >20k → { kind:"skipped", path, reason:"too-large", isUntracked:true }
        否则 git diff --no-index /dev/null <file>（带 prefix 归一化参数）→ 同一转码管线
        → extraFiles [{ kind:"patch", path, patchText: 自产转码 diff, isUntracked: true }]
        ⚠ 不用 untrackedPaths：宿主合成 added-file diff 时自行读工作区文件，
          会再次按 UTF-8 解码，乱码复现（ADR-0002）；0.22.0 内置已改走 untrackedPaths，
          本扩展维持 extraFiles 自产 diff（编码差异所致，见 ADR-0002）
  6. 返回 { repoRoot, sourceLabel, title, patchText, extraFiles, sourceCacheKey }
```

`input.options` 需要透传的开关：

- `colorMoved`：M2 一律 `--no-color`（见 6.5）；M3 按内置 `resolveGitColorMovedOptionsAsync` 拼装。
- `excludeUntracked`：为 true 时跳过第 5 步。
- `range` / `rangeEndpoints` / `pathspecs`：M2 完整支持（Q13）。

### 6.2 `readFileSource`（M2 核心，精确文件源）

```ts
readFileSource: async ({ path, previousPath, changeType, side, isUntracked }, ctx) => {
  // 端点已由 load() 解析并闭包引用（复刻内置 gitEndpointSourceSpec）：
  //   git-ref  → git show <ref>:<path>（old 侧；previousPath ?? path）
  //   index    → git show :<path>
  //   worktree → 读工作区文件字节
  //   none     → null
  // side === "old" && changeType === "new"  → null
  // side === "new" && changeType === "deleted" → null
  // 二进制/不存在 → null；字节 >1MB → { kind: "too-large", maxBytes: 1_000_000 }
}
```

- **按 (path, side) 独立探测编码**（Q9）：old 从 blob 字节、new 从 index/worktree 字节各自 `detectEncoding`，不共享结果——跨版本改编码的文件两侧各自正确。
- 探测复用 `transcode.ts`；返回 UTF-8 字符串，供 Hunk 做上下文展开、行内高亮与 word-diff。
- `sourceCacheKey`（复刻内置 + 追加编码配置指纹，Q9）：`git-source-v1:<old端key>:<编码指纹>:<new端key>:<编码指纹>`，其中端 key 为 `ref:<解析后完整 sha>` / `index:<sha256(git ls-files --stage -z)>` / `worktree` / `none`。**实现修正**：单侧"所用编码"在混合仓库中不存在（逐文件探测），故 5 段中的编码槽位放**编码配置指纹**（`sha256(JSON.stringify({encodings, fallback, overrides}))` 取 12 hex）——任何编码配置变更都会更换 key，配置热更新自动失效高亮缓存，语义上严格强于逐侧单编码。

### 6.3 `revision-show`（M3）

复刻内置 `buildGitShowArgs`：`git ... show --format= --no-ext-diff --find-renames --no-color [<ref>] [-- <pathspecs>]` 以字节执行 → 同一分段重编码管线。端点：`{ old: <ref>^, new: <ref> }`（0.22.0 语义）。供 `hunk show <rev>` 使用。

### 6.4 `stash-show`（M3）

复刻内置 `buildGitStashShowArgs`：`git ... stash show -p --no-ext-diff --find-renames --no-color [<ref>]`（默认 `stash@{0}`，无 pathspec）→ 同一管线。

### 6.5 `watch` 与 `colorMoved`（M3）

- `watchSignature(input, ctx)`：**复刻内置形状**（Q5，Promise 返回，apiVersion 25）：
  ```
  [转码后的 patchText, ...untracked.map(f => `untracked:${path}:${size}:${mtimeMs}:${ino}` 或 `...:missing`)]
      .join("\n---\n")
  ```
  用转码后的文本做签名，额外收益：**编码配置变了签名也变 → 自动热重载**。代价是每 tick 一次（或多次）子进程，可接受。
- `colorMoved`：M2 一律 `--no-color`（丢失 moved-line 着色，不影响正确性）。M3 复刻内置 `resolveGitColorMovedOptionsAsync`：读 `git config diff.colorMoved` / `diff.colorMovedWS`，配置 false → 无；true → `zebra`；显式值 → 原样；未设 → 取 `input.options.colorMoved`。启用时参数为 `--color=always --color-moved=<mode>` + 内置同款 `-c color.diff.oldMoved=magenta bold ...` 固定颜色，并透传 ANSI（Q4，见 §4.7）。`watchSignature` 与 numstat 预扫描始终 `--no-color`。

### 6.6 不支持面

- `history`（`hunk log` 交互）：不实现（Q6），Hunk 对未提供的 capability 报"不支持"，不会崩溃。避免为了 log 复刻整套提交图遍历；记为未来工作。
- **combined diff（`diff --cc`）内容行转码**：v1 透传（Q10），记为 M4+ 增强。
- 纯 patch 输入（`hunk patch foo.diff` 读磁盘文件）：不经 VCS 适配器，不在本插件范围，写入 README 说明。

## 7. 配置设计

```toml
# ~/.config/hunk/config.toml 或 .hunk/config.toml
[extension.hunk-custom-encoding]
encodings = ["gbk", "big5", "shift_jis"]          # 候选列表，顺序即优先级
fallback = "gbk"                                   # 候选全失败时的兜底（再失败 → latin1）
overrides = { "legacy/**/*.txt" = "gbk", "*.csv" = "gbk" }
# 斜杠启发式：含 "/" → path target；否则 → basename（Q11）
```

`config.ts` 校验：

- `encodings` 必须是**白名单内**的 legacy 编码名（Q12，见 §5），且 `new TextDecoder(name)` 能构造才接受；去重、限长。
- `overrides` 的 key 沿用 Hunk glob 语法（`registerFileLanguage` 同款：Bun shell 风格、大小写敏感、`/` 为 review-path 分隔符），target 按**斜杠启发式**判定（Q11）；value 走同一白名单。
- 非法值忽略并 `ctx.notify` 提示，不回退整个扩展。

**信任说明**：`hunk.config` 会被仓库级 config 覆盖（不可信输入）。编码选择只影响**显示**，不涉及命令执行/路径拼接，风险可控；但文档中仍需声明，避免未来把编码名用于拼路径等 exec 决策。

## 7.1 使用范围：零配置开箱即用 / 需要 minimal 配置 / 处理不了

### A. 零配置开箱即用（装完扩展即可，日常零操作）

判定逻辑：每个文件独立探测（overrides → BOM → 严格 UTF-8 校验 → 候选列表顺序 → fallback → latin1），以下场景全部自动覆盖：

- **UTF-8 仓库**：严格校验直通，扩展完全透明，无任何行为差异；
- **UTF-8 + 单一非 UTF-8 编码混合仓库**（最常见，如一半 UTF-8 一半 GBK）：UTF-8 文件直通，非 UTF-8 文件按默认候选列表 `["gbk", "big5", "shift_jis"]` 解码，不需要任何配置；
- 单一非 UTF-8 编码仓库（如纯 GBK / 纯 Shift-JIS / 纯 Big5），只要该编码**在默认候选列表内且顺序与仓库主导编码一致**；
- 以上场景下的完整功能面：`hunk diff`（工作区 + 暂存 + untracked + range）、`readFileSource` 驱动的上下文展开 / 行内高亮 / word-diff，以及 M3 之后的 `hunk show` / `hunk stash show` / `--watch`。

### B. 需要 minimal 配置的使用范围（一次性调优）

需要写 `[extension.hunk-custom-encoding]` 配置，但仅需数行、且与仓库绑定后可长期复用：

| 场景 | 配置做法 |
| --- | --- |
| 仓库同时混有 **≥2 种不同的非 UTF-8 编码**（如 GBK + Big5 + Shift-JIS 并存） | `overrides` 按路径 glob 钉死每个目录/文件的编码——候选列表的顺序无法可靠区分重叠的 CJK 编码 |
| 目标编码**不在默认候选列表**（如 EUC-KR、ISO-8859-1 等） | 加入 `encodings` 列表（白名单校验，见 §5） |
| 默认候选顺序与仓库**主导编码不符**（如纯 Big5 仓库、默认 gbk 排第一导致误判） | 调整 `encodings` 顺序，或对相关路径写 `overrides` |

> 以上均为**一次性**动作：配置写在用户级 `~/.config/hunk/config.toml`（全局生效）或仓库级 `.hunk/config.toml`（随仓库分发，团队共享）。仓库级配置会被 Hunk 作为不可信输入处理，但本扩展的配置只影响显示，不涉及 exec。

### C. 完全处理不了的使用范围（需要扩展之外的动作或替代方案）

| 场景 | 用户需要做什么 | 是否可被扩展解决 |
| --- | --- | --- |
| `hunk patch foo.diff` 审查**外部生成的非 UTF-8 patch 文件** | 先 `iconv -f gbk -t utf-8 foo.diff` 转码，或改走 `hunk diff` 审 git 仓库 | **否**——patch 文件读取不经 VCS 适配器，`registerCliCommand` 也不能覆盖内置 `patch` 命令，无扩展钩子 |
| `hunk log` 交互式历史审查 | 本计划 v1 不实现 `history` capability（Q6），报"不支持"；改用 `hunk show <rev>` | **可补**——未来增加 `history` capability 即闭环（复用同一转码管线），记为未来工作 |
| jj / Sapling 仓库中的非 UTF-8 文件 | 在 git 仓库中审查，或等待 jj / sl 变体扩展 | **否（当前）**——适配器只 detect `.git`；后续可另注册 jj / sl 包装适配器 |
| merge commit 的 combined diff（`diff --cc`）内容转码 | 无（v1 透传，内容行可能仍乱码） | **可补**——M4+ 增强：识别 `@@@` 头与双前缀内容行后转码 |
| UTF-16 文件 | git 把含 NUL 的字节当二进制，显示 binary 占位（无乱码也无文本 diff）；需在仓库配 `.gitattributes`（如 `working-tree-encoding=UTF-16`）让 git 当作文本输出 | 部分——UTF-16 被 git 判为二进制时扩展无字节可读；需 git 侧配合 |
| `--no-extensions` 或扩展加载失败 | 回到内置 git 适配器，乱码复现 | 否——这是 Hunk 的故障隔离语义，本扩展不改变 |

## 8. 兼容性、风险与待确认事项

### R1（✅ 已确认）：复刻内置 git 适配器的命令行为

已对照 Hunk 源码逐条核实（0.21.1：`src/extensions/default/vcs/git/`；0.22.0：`packages/hunk-git/src/`），本计划直接采用，无需再验证：

- **比较基准**：无 range 非 staged → `git diff`（**index↔worktree**，不是 `git diff HEAD`）；staged → `git diff --staged`。
- **flags**：`--no-ext-diff --find-renames --no-color`；不带 `--binary`、不带 `--no-textconv`、patch 不带 `-z`；统一 `-c core.quotePath=true -c diff.noprefix=false -c diff.mnemonicPrefix=false -c diff.srcPrefix=a/ -c diff.dstPrefix=b/`。
- **untracked**：`git --no-optional-locks status --porcelain=v1 -z --untracked-files=all`（不是 `ls-files --others`）。
- **大文件跳过**：numstat 预扫描（`--numstat -z`），改动行数 >20000 或磁盘 >1MB → `:(exclude)` + `skipped`。
- **readFileSource**：`git show <ref>:<path>` / `git show :<path>` / fs 读；上限 `DEFAULT_SOURCE_TEXT_MAX_BYTES = 1_000_000`；`sourceCacheKey = git-source-v1:<old>:<new>`。
- **watchSignature**：转码后 patch + untracked stat 签名。

### R2（✅ 已确认）：乱码产生的确切环节

- 已对照源码：内置用 `Response.text()` / `Buffer.toString("utf8")`（UTF-8 **非 fatal**）解码 → **U+FFFD 替换符、字节丢失**，必须走适配器方案。
- 已本地实测：`git diff` 原样输出 GBK 字节（`d6 d0 ce c4`...），Hunk 侧解码替换。假设成立，无需回头调整。

### R3：Windows 特有问题

- git 命令参数中的路径需要正确的引号/`--` 分隔，避免 `git show <rev>:<path>` 被 shell 语义影响（用 `Bun.spawn` 数组参数，不经 shell）；
- `-z`（NUL 分隔）输出按字节处理，避免路径含换行；
- **`git diff --no-index /dev/null <file>` 在 Windows 可用**（已实测，ADR-0002 的途径成立），退出码为 1（有差异），需放进 `acceptedExitCodes`；
- 继承内置适配器对 Windows 换行/CRLF 的处理。

### R4：纯 UTF-8 仓库的零影响

UTF-8 段走严格校验直通，快速路径保证无额外开销、无行为差异。适配器对 UTF-8 仓库而言是"透明的 git"，唯一差异是 `--no-color` 的 moved-line 着色（M3 补齐）。

### R5：性能

- 全程单次线性扫描，无重复解码；
- 解码器按编码缓存复用（`TextDecoder` 实例池）；
- 大 patch 沿用内置的 numstat 预扫描 + 1MB 阈值，超大文件直接 `skipped`，不会进入转码管线；
- `sourceCacheKey` 让精确源的高亮结果可跨 reload 复用；编码进 key 后配置变更自动失效。

### 类型来源（✅ 已实施，ADR-0003）

`hunkdiff` npm 包（`npm i -g hunkdiff` 即 Hunk 本体，官方仓库 `modem-dev/hunk`）**官方发布扩展类型**：

- 包 `exports` 提供 `"./extension": { "types": "./dist/npm/extension/index.d.ts", ... }`，即 `import ... from "hunkdiff/extension"` 可直接解析到官方声明；
- 声明内容完整：`ExtensionVcsAdapter`、`ExtensionVcsPatchResult`、`ExtensionVcsFileSourceReader`、`HUNK_VCS_DETECTION_BASELINE_PRIORITY`、`HunkExtensionUserError` 等全部公开面均已导出；
- 官方仓库的 `tsconfig.extension.json` 从 `packages/hunk/src/extension-api/index.ts` 发射这些声明，随版本保持同步。

**结论：vendored 类型，零运行时依赖。** 仅拷贝官方发布声明中真正需要的 `dist/npm/extension/`（约 117K）到仓库 `types/hunkdiff-extension/`，并在 tsconfig 用 `paths` 把 `hunkdiff/extension` 映射到该目录。理由：`hunkdiff` npm 包会连带下载完整 hunk 二进制（约 117MB）与自动安装 peer 依赖（`@opentui/*`、`react`、`@pierre/diffs` 等合计约 100MB），而本扩展运行时 `hunkdiff/extension` 由 host 提供虚拟模块（Bun loader hook 重写 specifier），devDependency 只服务类型检查——直接 vendored 类型最干净。本扩展为纯 VCS 适配器，不涉及 pane/JSX，无需 `react` / `@opentui/*` 类型。版本对齐策略：`types/hunkdiff-extension/` 顶部注释记录来源版本；升级 hunk 时重新拷贝该目录即可，代码保留 `hunk.apiVersion` 分支。`bunfig.toml` 的 `[install] optional = false` 保留，防止未来误装平台二进制。

- **宿主环境要求（2026-09-12 实测）**：扩展需要提供 extension API **v25** 的宿主（对应 hunkdiff@0.22.0 的 JS 产物）。注意：npm `hunkdiff-windows-x64@0.22.0` 的预编译 `hunk.exe` 是**陈旧构建**——二进制自称 0.21.1、内嵌 `HUNK_EXTENSION_API_VERSION = 16`（`hunkdiff@0.22.0-beta.1` 的二进制也是 v24），与同包 v25 的 `dist/npm/` 资产错位（上游打包 bug，建议向 modem-dev/hunk 报告）。变通：把 `~/.bun/install/global/node_modules/hunkdiff-windows-x64` 改名（如 `hunkdiff-windows-x64.stale-v16-binary`），官方 bin shim 会回退到 `bun dist/npm/main.js`（内嵌 API = 25）运行宿主；`hunk --version` 应显示 0.22.0。已实测：`hunk diff` 正常加载扩展，GBK 文件显示 `- 旧内容 / + 新内容`，无 U+FFFD。上游修复后可还原目录名或直接升级。

**JS 宿主的 peer 依赖要求**：从 `dist/npm/main.js` 运行宿主时，`@opentui/core` 等peer 需满足 hunkdiff@0.22.0 的 `^0.5.6`。若全局残留旧 peer（如 0.5.4），OpenTUI 初始化会报 `Symbol "createEmbeddedTerminal" not found`（0.5.4 的 DLL 无此导出）。修复：`bun add -g @opentui/core@0.5.11 @opentui/react@0.5.11`（0.5.x 最新，DLL 实测含该符号），`@pierre/diffs@1.3.5` / `react@^19.2.4` 保持满足即可。查重（2026-09-12，open+closed）：以 `windows` / `opentui` / `apiVersion` / `"extension API"` / `hunkdiff-windows` / `createEmbeddedTerminal` 检索 modem-dev/hunk 均无重复报告，可安全提 issue（草稿见对话记录）。

### 里程碑现状（M0/M1/M2 已落地，2026-09-12）

- **M0 验收结果**：`package.json` 已修复（提交 `0e58a62`，`"hunk": { "extensions": ["index.ts"], "apiVersion": 25 }`）；vendored 官方类型已落地（提交 `5468982`，`types/hunkdiff-extension/` + tsconfig `paths`）；`bun install` 通过、node_modules 无 hunkdiff/opentui/react 残留、`hunkdiff/extension` 类型检查通过（`tsc` 仅剩 `examples/` 模板示例的 JSX 报错，属初始模板内容、与本扩展无关）。`index.ts` 真实入口已随 M2 写入。
- **M1 已落地**：`src/config.ts`（canonical 白名单表 + overrides 斜杠启发式 glob 编译/最长匹配 + 校验与 notify）、`src/transcode.ts`（六层探测链 + 转码 + TextDecoder 实例池 + ANSI 剥离 + ASCII 快速路径）、`src/patch.ts`（按 `diff --git`/`diff --cc` 分段 + 逐内容行转码 + 二进制/combined 透传 + `\ No newline` 保留）。`bun run test`（= `bun test test/`，避开模板 examples）全绿。
- **M2 已落地**：`src/git.ts`（字节模式 spawn + 参数组装 + 错误翻译，逐位复刻内置 `commands.ts`）、`src/endpoints.ts`（`resolveGitDiffEndpoints` 复刻：staged HEAD^{commit}/none、单正 rev→worktree、`A..B`、`A...B` merge-base、多 rev → null）、`src/adapter.ts`（numstat 大文件跳过、untracked 自产 diff、readFileSource 按 (path, side) 独立探测 + 编码配置指纹进 cacheKey）、`index.ts` 入口（注册适配器 + 解析 `[extension.hunk-custom-encoding]` 配置）。**untracked gating 与 cacheKey 形状已按内置源码核实修正**（见 §6.1/§6.2）；`test/git.test.ts` 纯函数 + `test/adapter.integration.test.ts`（真 fixture 仓库，GBK/SJIS/Big5/二进制/untracked/staged/range/rangeEndpoints/Q9 双侧探测/UTF-8 基线逐字节一致）全绿，共 104 用例。
- **测试基建**：`test/runtime.ts` + bunfig `[test] preload` 用 Bun plugin 把 `hunkdiff/extension` 映射到 vendored 官方运行时（host 之外的测试环境替身，`HunkExtensionUserError` 行为一致）。
- **实测修正（Bun 1.3.13）**：`new TextDecoder("gbk").encoding` 返回 `"gbk"` 而非 WHATWG 规范名 `"gb18030"`——canonical 归一改用自维护映射表（见 `src/config.ts`），`"gbk"/"gb2312"/"gb18030"` 统一为 `"gbk"`，`"latin1"/"iso-8859-1"` → `"windows-1252"`，`"cp866"` → `"ibm866"`；Big5「體」实测为 `C5 E9`。

## 9. 测试计划

### 9.1 单测（`bun test`，纯函数）

- `transcode.test.ts`：
  - 各编码样例字节 → 正确 UTF-8 文本（GBK 中文、Shift-JIS 日文、Big5 繁中、UTF-8 直通、UTF-8 BOM）；
  - 非法序列 fatal 抛错 → 回退下一候选；全部候选失败 → fallback → latin1 最终兜底；
  - overrides（含斜杠启发式：path vs basename）优先、encodings 顺序生效；
  - 纯 ASCII 快速路径。
- `patch.test.ts`：
  - 混合仓库 patch：UTF-8 文件 + GBK 文件 + 二进制段 + rename 段 + mode-only 段 + `diff --cc` 段（透传）→ 只转内容行、路径不变乱码；
  - `\ No newline at end of file` 保留；
  - 子模块段透传。

### 9.2 集成测试（fixture git 仓库，adapter 层 in-process）

- `fixtures/` 用脚本构建一个真 git 仓库：GBK / Shift-JIS / Big5 / UTF-8 / UTF-8-BOM / 二进制文件各有改动，含 untracked 文件；
- **直接调用适配器的 `load()` / `readFileSource()`**（带 fake ctx `{ cwd, signal }`）断言：
  - `patchText` 中不再出现 `U+FFFD`，中文/日文/繁中正确显示；
  - 段分类正确（二进制/子模块/mode-only/combined 透传）；
  - untracked 走 `extraFiles` 自产 diff，无乱码；
  - range / rangeEndpoints / staged 路径的端点解析与 `git diff` 一致；
  - `readFileSource` 两侧独立探测（构造旧 GBK 新 UTF-8 的改写场景）；
  - `sourceCacheKey` 随编码变化。
- 反向断言：纯 UTF-8 仓库的 `load()` 输出与内置 git 适配器基线一致（diff 语义无回归）。

### 9.3 手工验证清单（PTY 相关）

- `hunk diff`（工作区/暂存/untracked/range）、`hunk show`（revision-show）、stash、`--watch` 热重载（改编码配置应触发重载）；
- 大文件 `too-large` 占位；
- Windows 路径含空格/中文的仓库；
- `--color-moved`（M3）下 moved 行着色且无乱码。

## 10. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M0 | ✅ 修 package.json、补 apiVersion、vendored 官方类型；剩余 `index.ts` 入口（注册适配器 + 读配置） | `bun install` 通过，扩展能被发现，`import ... from "hunkdiff/extension"` 类型检查通过，node_modules 无 hunkdiff/opentui/react 残留 |
| M1 | `transcode.ts` + `patch.ts` + 单测 | 纯函数单测全绿 |
| M2 | `git.ts` + `working-tree-diff`（含 range/rangeEndpoints、numstat 大文件跳过、untracked 自产 diff）+ `readFileSource`（按 side 独立探测 + 编码进 cacheKey） | fixture 仓库 adapter 层集成测试全绿：GBK 无乱码、UTF-8 无回归 |
| M3 | `revision-show` / `stash-show` / `watchSignature`（转码 patch + stat 签名）/ `colorMoved`（透传 ANSI） | 对应命令与手工清单验证通过 |
| M4 | README（含 `.gitattributes working-tree-encoding` 补充方案、信任说明、配置文档、已知局限）、combined diff 转码增强（可选） | 文档齐备；扩展保持 `private`（Q14） |

## 11. 结论

本插件通过一个包装 Git 的 VCS 适配器，在"字节 → 文本"解码环节介入：逐位复刻内置 git 适配器的命令语义（ADR-0004），以二进制方式运行 git、按文件分段、overrides/BOM/严格 UTF-8/候选列表/双级兜底五层探测编码、只对内容行转码为 UTF-8，并配套 `readFileSource` 精确文件源（按侧独立探测、编码进缓存键）与 untracked 自产 diff（ADR-0002）。它不需要修改被审查仓库，不引入运行时依赖（ADR-0003），且对纯 UTF-8 仓库完全透明。核心风险——接管 git 仓库后必须与内置 git 适配器的 diff 语义保持一致——已通过源码对照消除（R1/R2 均确认）；14 项决策（§0）与 4 篇 ADR 保证后续实现不再有悬而未决的设计分歧。