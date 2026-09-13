# hunk-custom-encoding

 **[English](./README.md)** · 中文

给 Hunk 装上这个扩展后,用 GBK、Big5、Shift-JIS 等老编码的仓库在 `hunk diff`、`hunk show` 里就能看到正常的中文、日文,不再满屏乱码。它只是帮 Hunk"看懂"文件,**不会改动你的仓库**。

## 简介

Hunk 自带的 Git 功能默认把所有内容当 UTF-8 来读,老编码的内容自然变成乱码。这个扩展会在中间接手:先判断每个文件用的是哪种编码,转好再交给 Hunk。本来就是 UTF-8 的仓库,显示效果和自带功能一模一样,没有影响。

## 安装

```bash
hunk extension install KisenaMiyuki/hunk-custom-encoding
```

- 如果 Hunk 版本太旧,会收到一条明确的版本提示,照着升级就行。
- 临时关掉扩展:`hunk --no-extensions`(Hunk 自带的功能不受影响)。

## 使用

| 指令 | 支持 | 说明 |
| --- | --- | --- |
| `hunk diff` | ✅ | 中文正常显示 |
| `hunk diff --staged` | ✅ | 同上 |
| `hunk diff <commit>` | ✅ | 新建的、还没登记的文件也会一起显示 |
| `hunk show <commit>` | ✅ | 看提交内容,顺带显示作者、时间等提交信息 |
| `hunk stash show` | ✅ | 不写编号就看最近一次 |
| `hunk diff --watch` | ✅ | 文件一变自动刷新;改编码配置也会自动刷新 |
| `--color-moved` | ✅ | 颜色照常,中文照常 |
| `hunk log` | ❌ | 会提示"不支持" |
| `hunk patch <patch file>` | ⚠️ | 直接读补丁文件,不经过本扩展,不会转码 |

合并提交(merge)的 diff 也能正常显示中文。

## 为什么不用 .gitattributes working-tree-encoding?

git 其实自带一个办法(在 `.gitattributes` 里设置 `working-tree-encoding`),但它有个大问题:checkout 时会**真的改写磁盘上的文件**。文件内容变了、git 记录也跟着变,其他不认识这个设置的工具看到的文件也会不一样。

这个扩展走的是另一条路:**只改"看"的方式,不改文件**。

- 不动磁盘文件,仓库保持原样;
- 不用每个仓库单独设置,装一次到处能用;
- 一个仓库里混着多种编码也能搞定,可以按文件指定编码。

如果你已经在用 git 自带的方案而且没问题,继续用就好,两者不冲突。

## 配置

```toml
# 配置文件:~/.config/hunk/config.toml(全局)或 .hunk/config.toml(仅当前仓库)
[extension.hunk-custom-encoding]
encodings = ["gbk", "big5", "shift_jis"]   # 挨个试这些编码,先猜中先用
# fallback = "gbk"    # 上面全猜不中时用的兜底编码,默认就是 gbk

[extension.hunk-custom-encoding.overrides]
"sjis.txt" = "shift_jis"      # 按文件名指定:任何目录下的 sjis.txt 都用 shift_jis
"src/legacy/**" = "gbk"       # 写了斜杠就按完整路径指定
```

判断一个文件用什么编码的顺序:先看 `overrides` 有没有指定 → 看文件开头有没有 BOM 标记 → 看它是不是本来就符合 UTF-8 → 按 `encodings` 列表挨个试 → 用 `fallback` → 最后按 latin1 兜底(这个一定出得来结果)。

编码名写错了不会崩,状态栏会提示一句,然后继续用默认值。

仓库里的 `.hunk/config.toml` 会覆盖全局配置里的同名设置(一项一项地覆盖)。这是 Hunk 的正常机制,不用担心;本扩展只会从配置里读编码名字,不会拿配置去执行任何程序,写错了也只是提示。

**GBK 和 Shift-JIS 会"撞车"**:这两种编码有很多字节长得一模一样。默认顺序下,日文文件经常被当成 GBK 解出一堆怪字。解决办法:用 `overrides` 给这类文件单独指定编码,或者调整 `encodings` 的顺序。

## 已知局限

- 自动猜编码不是百分百准,混着多种编码的仓库建议用 `overrides` 手动指定。
- 二进制文件、子模块、UTF-16 文件原样显示——git 本来就把它们当二进制,没有可转的文字。
- 特别大的文件(变更超过 2 万行,或超过 1MB)只显示行数统计,不显示具体内容。这和 Hunk 自带的行为一致。
- 合并提交的 diff 内容能正常转码,但在"不带交互界面"的运行方式下不显示,请正常打开 hunk 看。
- `hunk patch 补丁文件` 完全不经过本扩展,所以补丁文件本身不会被转码。

## 开发

```bash
bun install       # 装依赖(运行时零依赖,类型文件已经内置在仓库里)
bun run test      # 跑测试:163 个用例,包括真实 git 仓库的集成测试
bunx tsc --noEmit # 类型检查
```

测试用的 git 仓库里提交的都是真实的 GBK、日文、繁体字节,所以每个解码结果都是可复现、可对照的。

## 环境备注(bun):全局更新的问题

用 `bun add -g hunkdiff` 升级 Hunk 时,bun 有个毛病:可能只更新了 package.json 这类小文件,却**没换掉那个一百多 MB 的 hunk.exe**(文件是硬链接的,它还连着旧版本)。结果就是:包明明显示 0.22.0,`hunk --version` 却报 0.21.1,装扩展时报"API v16"。同时,`@opentui/core` 这类依赖也可能停在旧版,报 `Symbol "createEmbeddedTerminal" not found`。

遇到这种情况,彻底重装一次就好:

```bash
bun remove -g hunkdiff && rm -rf ~/.bun/install/global/node_modules/hunkdiff-windows-x64* && bun add -g hunkdiff
```

来龙去脉见 `docs/custom-encoding-implementation-plan.md` 的"宿主环境要求"一节。
