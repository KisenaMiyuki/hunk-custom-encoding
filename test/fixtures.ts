/**
 * Fixture git repositories for adapter-level integration tests (plan §9.2).
 *
 * Built with real `git` commands into a temp dir; files are written as raw
 * bytes so the committed blobs carry exact GBK / Shift-JIS / Big5 payloads.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FixtureRepo {
  root: string;
  /** Head commit of `main` (everything is committed here first). */
  headSha: string;
  /** Head commit of the `side` branch, forked from `headSha`. */
  sideSha: string;
  cleanup(): void;
}

/** hex → bytes helper (fixture payloads are pinned legacy bytes). */
export function hx(input: string): Buffer {
  return Buffer.from(input.replace(/\s+/g, ""), "hex");
}

function runGit(root: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", "-c", "core.autocrlf=false", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr ?? []).toString("utf8");
    throw new Error(`fixture git ${args.join(" ")} failed: ${stderr}`);
  }
}

function gitOut(root: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-c", "core.autocrlf=false", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = Buffer.from(proc.stderr ?? []).toString("utf8");
    throw new Error(`fixture git ${args.join(" ")} failed: ${stderr}`);
  }
  return Buffer.from(proc.stdout ?? []).toString("utf8").trim();
}

function commitAll(root: string, message: string): void {
  runGit(root, ["add", "-A"]);
  runGit(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-q", "-m", message]);
}

/** Known legacy byte payloads (verified in test/transcode.test.ts). */
const GBK_JIUNR = hx("bec9c4dac8dd0a"); // 旧内容\n
const GBK_XINNR = hx("d0c2c4dac8dd0a"); // 新内容\n
const GBK_JIUZW = hx("bec9d6d0cec40a"); // 旧中文\n
const SJIS_NIHONGO = hx("93fa967b8cea0a"); // 日本語\n
const SJIS_KONNICHIWA = hx("82b182f182c982bf82cd0a"); // こんにちは\n
const BIG5_CESHI = hx("b4fab8d50a"); // 測試\n
const BIG5_FANTIZHONGWEN = hx("c163c5e9a4a4a4e50a"); // 繁體中文\n

/**
 * Mixed-encoding repository:
 *
 *   - worktree modifications (unstaged): gbk/sjis/big5/utf8/bom/bin.dat,
 *     plus `switch.txt` rewritten from GBK to UTF-8 (Q9 scenario) and a
 *     1MB+ tracked file (numstat size gate);
 *   - staged: staged-utf8.txt modification, mode-only change on mode.txt,
 *     pure rename old-gbk.txt → renamed-gbk.txt;
 *   - untracked: GBK / Shift-JIS / UTF-8 files, a 20001-line file (line
 *     gate) and a 1MB+ file (size gate);
 *   - history: `main` = headSha, branch `side` forked from it.
 */
export function buildMixedEncodingRepo(): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "hunk-enc-mixed-"));
  try {
    const utf8 = (text: string) => Buffer.from(text, "utf8");
    const path = (name: string) => join(root, name);
    const write = (name: string, bytes: Buffer) => writeFileSync(path(name), bytes);

    runGit(root, ["init", "-q", "-b", "main"]);

    // ---- initial commit (c1) -------------------------------------------
    write("gbk.txt", GBK_JIUNR);
    write("sjis.txt", SJIS_NIHONGO);
    write("big5.txt", BIG5_CESHI);
    write("utf8.txt", utf8("第一版 中文\n"));
    write("bom.txt", Buffer.concat([hx("efbbbf"), utf8("bom 内容\n")]));
    write("bin.dat", Buffer.from([0x42, 0x49, 0x4e, 0x00, 0x31, 0x0a])); // BIN\0v1
    write("switch.txt", GBK_JIUZW);
    write("mode.txt", utf8("mode file\n"));
    write("old-gbk.txt", GBK_JIUNR);
    write("staged-utf8.txt", utf8("staged v1\n"));
    write("big-tracked.txt", Buffer.concat([Buffer.from("x".repeat(1_000_002)), utf8("\n")]));
    commitAll(root, "initial");
    const headSha = gitOut(root, ["rev-parse", "HEAD"]);

    // ---- side branch (s1), forked from c1 -------------------------------
    runGit(root, ["checkout", "-q", "-b", "side"]);
    write("side.txt", utf8("side content\n"));
    commitAll(root, "side commit");
    const sideSha = gitOut(root, ["rev-parse", "HEAD"]);
    runGit(root, ["checkout", "-q", "main"]);

    // ---- unstaged worktree modifications --------------------------------
    write("gbk.txt", GBK_XINNR);
    write("sjis.txt", SJIS_KONNICHIWA);
    write("big5.txt", BIG5_FANTIZHONGWEN);
    write("utf8.txt", utf8("第二版 中文修改\n"));
    write("bom.txt", Buffer.concat([hx("efbbbf"), utf8("bom 修改\n")]));
    write("bin.dat", Buffer.from([0x42, 0x49, 0x4e, 0x00, 0x32, 0x0a])); // BIN\0v2
    write("switch.txt", utf8("新中文 utf8\n"));
    write(
      "big-tracked.txt",
      Buffer.concat([
        Buffer.from("x".repeat(500_000)),
        utf8("y\n"),
        Buffer.from("x".repeat(500_001)),
        utf8("\n"),
      ]),
    );

    // ---- staged changes --------------------------------------------------
    write("staged-utf8.txt", utf8("staged v2\n"));
    runGit(root, ["add", "staged-utf8.txt"]);
    runGit(root, ["update-index", "--chmod=+x", "mode.txt"]);
    runGit(root, ["mv", "old-gbk.txt", "renamed-gbk.txt"]);

    // ---- untracked files --------------------------------------------------
    write("untracked-gbk.txt", GBK_XINNR);
    write("untracked-sjis.txt", SJIS_KONNICHIWA);
    write("untracked-utf8.txt", utf8("untracked utf8\n"));
    write("untracked-many.txt", Buffer.from("l\n".repeat(20_001)));
    write("untracked-big.txt", Buffer.from("z".repeat(1_000_001)));

    return {
      root,
      headSha,
      sideSha,
      cleanup() {
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Pure-UTF-8 repository for the no-regression baseline: everything ASCII or
 * valid UTF-8, so the adapter must be a transparent pass-through.
 */
export function buildUtf8OnlyRepo(): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "hunk-enc-utf8-"));
  try {
    const utf8 = (text: string) => Buffer.from(text, "utf8");
    const write = (name: string, bytes: Buffer) => writeFileSync(join(root, name), bytes);

    runGit(root, ["init", "-q", "-b", "main"]);
    write("hello.txt", utf8("hello world\n"));
    write("中文.txt", utf8("中文内容\n"));
    commitAll(root, "initial");
    const headSha = gitOut(root, ["rev-parse", "HEAD"]);

    write("hello.txt", utf8("hello changed\n"));
    writeFileSync(join(root, "new-utf8.txt"), utf8("brand new\n"));

    return {
      root,
      headSha,
      sideSha: headSha,
      cleanup() {
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
