# hunk-custom-encoding

 English · **[中文](./README.zh-CN.md)**

Per-file encoding transcoding for [Hunk](https://hunk.dev)'s Git reviews: non-UTF-8 repositories — GBK, Big5, Shift-JIS and friends — render as proper text instead of mojibake, with zero changes to the repository under review.

## Overview

The extension registers a VCS adapter (`hunk-custom-encoding`) that wraps Git byte-exactly: every patch-producing `git` command runs with raw byte stdout, and patch content is transcoded to UTF-8 segment by segment before Hunk sees it. Pure-UTF-8 repositories are byte-identical to the built-in adapter, and nothing in the reviewed repository is ever rewritten — detection and decoding happen per review.

## Install

```bash
hunk extension install KisenaMiyuki/hunk-custom-encoding
```

The manifest pins `"hunk": { "apiVersion": 25 }` — older Hunk binaries refuse the folder with a clear message. `hunk --no-extensions` turns the extension off for one run (Hunk's bundled backends stay loaded).

## Usage

| Command | Status | Notes |
| --- | --- | --- |
| `hunk diff` / `hunk diff --staged` | ✅ | tracked changes, byte-mode transcode |
| `hunk diff <ref>` / `<from> <to>` / ranges | ✅ | untracked files included whenever the new side is the live worktree |
| `hunk show [ref]` | ✅ | parent-pinned source reads (`<id>^` ↔ `<id>`); root commits degrade the old side |
| `hunk stash show [ref]` | ✅ | defaults to `stash@{0}` |
| `hunk diff --watch` | ✅ | polled signatures built from transcoded text — an encoding-config change retriggers the review |
| `--color-moved` / `diff.colorMoved` | ✅ | ANSI passthrough; git's fixed moved-line palette is replicated |
| `hunk log` | ❌ | reports "not supported" |
| `hunk patch <file>` | ⚠️ | direct file input never reaches VCS adapters — such files are not transcoded |

Merge-commit reviews (`diff --cc`) transcode their two-sign-column content lines too.

## Why not `.gitattributes working-tree-encoding`?

Git's native answer re-encodes files **on checkout**: the working copy is rewritten, the index churns, and other tools that don't know about the attribute see different bytes. This extension takes the read-only route instead:

- no working-tree or index changes — detection and decoding happen per review;
- no per-repo setup; the same configuration covers every legacy repo you review;
- per-file `overrides` for repos with mixed encodings, which a single repo-wide attribute cannot express.

If you already use `working-tree-encoding` and it works for you, keep it — the extension is an alternative, not a prerequisite.

## Configuration

```toml
# ~/.config/hunk/config.toml or .hunk/config.toml
[extension.hunk-custom-encoding]
encodings = ["gbk", "big5", "shift_jis"]   # candidates in priority order
# fallback = "gbk"                          # default; used after the candidates fail (latin1 is the final net)

[extension.hunk-custom-encoding.overrides]
"sjis.txt" = "shift_jis"          # basename match — any depth
"src/legacy/**" = "gbk"           # contains "/" → full repo-relative path match
```

Detection order per content segment: `overrides` → BOM → strict UTF-8 passthrough → candidates in order → `fallback` → latin1 (never fails). Encoding names are validated against a whitelist and canonicalized (`gbk`/`gb2312`/`gb18030` → `gbk`, `latin1` → `windows-1252`); unknown names are rejected with a statusbar notice.

Repo config overrides user config **key by key** — a reviewed repository can retune this extension. That is a normal Hunk workflow; the extension only uses the config for encoding names, never for anything exec-adjacent, and invalid values never reach the decoders.

**CJK ambiguity**: Shift-JIS and GBK share many byte sequences. With the default candidate order a Shift-JIS file usually decodes as GBK — pin such files with `overrides` or reorder `encodings`.

## Known limitations

- Detection is a per-segment heuristic, not a guarantee — mixed-encoding repos should use `overrides`.
- Binary files, submodules, and UTF-16 content pass through untouched (git already treats them as binary).
- Files above 20 000 changed lines or 1 MB are skipped with stats instead of a rendered diff (same gates as the built-in).
- Combined (`diff --cc`) segments decode content but `hunk show` on a merge commit does not render headless (non-TTY static mode) — review those in the interactive TUI.
- `hunk patch <file>` bypasses VCS adapters entirely, so patch files stay untouched.

## Development

```bash
bun install          # no runtime dependencies; types are vendored
bun run test         # bun test test/ — 163 cases incl. fixture-repo integration
bunx tsc --noEmit    # clean except the bun-init template in examples/
```

`types/hunkdiff-extension/` vendors the official extension types and runtime for the pinned host API (v25); `test/runtime.ts` maps `hunkdiff/extension` to it outside the real host. Fixture repos (`test/fixtures.ts`) commit exact legacy bytes so every decode is pinned.
