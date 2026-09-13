/**
 * Unit tests for src/patch.ts (plan §9.1).
 *
 * Patches are assembled from raw byte pieces so the tests pin down exact
 * legacy bytes inside diff content lines (content 行) while headers stay
 * ASCII (core.quotePath=true semantics).
 */
import { describe, expect, test } from "bun:test";
import { parseExtensionSettings } from "../src/config";
import { transcodePatch } from "../src/patch";

function hex(input: string): Uint8Array {
  const clean = input.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2)!, 16)!;
  }
  return out;
}

const encoder = new TextEncoder();

/** Concatenate string (UTF-8) and raw byte pieces into one byte stream. */
function patch(...parts: (string | Uint8Array)[]): Uint8Array {
  const encoded = parts.map((part) =>
    typeof part === "string" ? encoder.encode(part) : part,
  );
  const total = encoded.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of encoded) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** What the built-in adapter would see: plain lenient UTF-8 decoding. */
function builtinDecode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

// ---------------------------------------------------------------------------
// Byte fixtures
// ---------------------------------------------------------------------------

const GBK_OLD = hex("bec9d6d0cec4"); // 旧中文
const GBK_NEW = hex("d0c2d6d0cec4"); // 新中文
const GBK_CONTEXT = hex("c9cfcfc2cec4"); // 上下文
const GBK_NEIRONG_OLD = hex("bec9c4dac8dd"); // 旧内容
const GBK_NEIRONG_NEW = hex("d0c2c4dac8dd"); // 新内容
const SJIS_JAPANESE = hex("93fa967b8cea"); // 日本語
const SJIS_KONNICHIWA = hex("82b182f182c982bf82cd"); // こんにちは

const ASCII_SECTION =
  [
    "diff --git a/a.txt b/a.txt",
    "index 1111111..2222222 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,2 @@",
    "-hello",
    "+world",
    " context line",
  ].join("\n") + "\n";

const GBK_SECTION = patch(
  "diff --git a/gbk.txt b/gbk.txt\n",
  "index 3333333..4444444 100644\n",
  "--- a/gbk.txt\n",
  "+++ b/gbk.txt\n",
  "@@ -1,2 +1,2 @@\n",
  "-",
  GBK_OLD,
  "\n",
  "+",
  GBK_NEW,
  "\n",
  " ",
  GBK_CONTEXT,
  "\n",
);

const SJIS_SECTION = patch(
  "diff --git a/sjis.txt b/sjis.txt\n",
  "index 5555555..6666666 100644\n",
  "--- a/sjis.txt\n",
  "+++ b/sjis.txt\n",
  "@@ -1,1 +1,1 @@\n",
  "-",
  SJIS_JAPANESE,
  "\n",
  "+",
  SJIS_KONNICHIWA,
  "\n",
);

const BINARY_SECTION =
  [
    "diff --git a/bin.dat b/bin.dat",
    "index 7777777..8888888 100644",
    "Binary files a/bin.dat and b/bin.dat differ",
  ].join("\n") + "\n";

const GIT_BINARY_SECTION = patch(
  "diff --git a/blob.bin b/blob.bin\n",
  "index 9999999..aaaaaaa 100644\n",
  "GIT binary patch\n",
  "literal 10\n",
  hex("c0c1c2"),
  "\n",
);

const RENAME_SECTION = patch(
  "diff --git a/old.txt b/renamed.txt\n",
  "similarity index 90%\n",
  "rename from old.txt\n",
  "rename to renamed.txt\n",
  "--- a/old.txt\n",
  "+++ b/renamed.txt\n",
  "@@ -1,1 +1,1 @@\n",
  "-",
  GBK_NEIRONG_OLD,
  "\n",
  "+",
  GBK_NEIRONG_NEW,
  "\n",
);

const MODE_ONLY_SECTION =
  ["diff --git a/mode.txt b/mode.txt", "old mode 100644", "new mode 100755"].join(
    "\n",
  ) + "\n";

const COMBINED_SECTION = patch(
  "diff --cc a/merge.txt\n",
  "index 1111111,2222222..3333333\n",
  "--- a/merge.txt\n",
  "+++ b/merge.txt\n",
  "@@@ -1,1 -1,1 +1,1 @@@\n",
  "- ",
  GBK_OLD,
  "\n",
  "++",
  GBK_NEW,
  "\n",
);

const NOEOL_SECTION = patch(
  "diff --git a/eol.txt b/eol.txt\n",
  "index bbbbbbb..ccccccc 100644\n",
  "--- a/eol.txt\n",
  "+++ b/eol.txt\n",
  "@@ -1 +1 @@\n",
  "-",
  GBK_OLD,
  "(old)\n",
  "\\ No newline at end of file\n",
  "+",
  GBK_NEW,
  "(new)\n",
  "\\ No newline at end of file\n",
);

const DELETED_SECTION = patch(
  "diff --git a/del.txt b/del.txt\n",
  "index ddddddd..0000000 100644\n",
  "--- a/del.txt\n",
  "+++ /dev/null\n",
  "@@ -1 +0,0 @@\n",
  "-",
  GBK_OLD,
  "\n",
);

const SUBMODULE_SECTION =
  [
    "diff --git a/sub b/sub",
    "index abcdef0..1234567 160000",
    "--- a/sub",
    "+++ b/sub",
    "@@ -1 +1 @@",
    "-Subproject commit abcdef0123456789",
    "+Subproject commit 1234567890abcdef",
  ].join("\n") + "\n";

const MULTI_HUNK_SECTION = patch(
  "diff --git a/multi.txt b/multi.txt\n",
  "index eeeeeee..fffffff 100644\n",
  "--- a/multi.txt\n",
  "+++ b/multi.txt\n",
  "@@ -1 +1 @@\n",
  "-",
  hex("bec9d2bb"), // 旧一
  "\n",
  "+",
  hex("d0c2d2bb"), // 新一
  "\n",
  "@@ -5 +5 @@\n",
  "-",
  hex("bec9cee5"), // 旧五
  "\n",
  "+",
  hex("d0c2cee5"), // 新五
  "\n",
);

const OVERRIDE_SECTION = patch(
  "diff --git a/legacy/enc.txt b/legacy/enc.txt\n",
  "index 1234321..4321234 100644\n",
  "--- a/legacy/enc.txt\n",
  "+++ b/legacy/enc.txt\n",
  "@@ -1,1 +1,1 @@\n",
  "-",
  GBK_OLD,
  "\n",
  "+",
  GBK_NEW,
  "\n",
);

const defaults = parseExtensionSettings(undefined);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("transcodePatch — segments", () => {
  test("GBK content lines are transcoded, headers untouched", () => {
    const text = transcodePatch(GBK_SECTION, defaults);
    expect(text).toBe(
      [
        "diff --git a/gbk.txt b/gbk.txt",
        "index 3333333..4444444 100644",
        "--- a/gbk.txt",
        "+++ b/gbk.txt",
        "@@ -1,2 +1,2 @@",
        "-旧中文",
        "+新中文",
        " 上下文",
      ].join("\n") + "\n",
    );
    expect(text).not.toContain("\uFFFD");
  });

  test("UTF-8 segment passes through byte-identical", () => {
    expect(transcodePatch(encoder.encode(ASCII_SECTION), defaults)).toBe(
      ASCII_SECTION,
    );
  });

  test("binary segments are passed through (no transcoding)", () => {
    expect(transcodePatch(encoder.encode(BINARY_SECTION), defaults)).toBe(
      BINARY_SECTION,
    );
    const text = transcodePatch(GIT_BINARY_SECTION, defaults);
    expect(text).toContain("GIT binary patch");
    // Same bytes the built-in adapter would decode — NOT gbk content.
    expect(text).toBe(builtinDecode(GIT_BINARY_SECTION));
    expect(text).not.toContain("旧中文");
  });

  test("combined (diff --cc) segments transcode both sign columns (Q10, M4)", () => {
    const text = transcodePatch(COMBINED_SECTION, defaults);
    expect(text).toContain("diff --cc a/merge.txt");
    expect(text).toContain("@@@ -1,1 -1,1 +1,1 @@@");
    // M4: two-sign-column content lines now decode instead of passing
    // through as mojibake (merge-commit reviews in GBK repos). Real git
    // always emits two columns: `- 旧中文` (removed vs parent 1), `++新中文`
    // (changed vs both).
    expect(text).toContain("- 旧中文");
    expect(text).toContain("++新中文");
    expect(text).not.toContain("\uFFFD");
  });

  test("painted combined content lines transcode too", () => {
    const bytes = patch(
      paint("1", "diff --cc a/merge.txt"),
      paint("1", "index 1111111,2222222..3333333"),
      paint("1", "--- a/merge.txt"),
      paint("1", "+++ b/merge.txt"),
      paint("36", "@@@ -1,1 -1,1 +1,1 @@@"),
      patch(`${E}31m- `, GBK_OLD, `${E}m\n`),
      patch(`${E}32m++`, GBK_NEW, `${E}m\n`),
    );
    const text = transcodePatch(bytes, defaults);
    expect(text).toContain("@@@");
    expect(text).toContain("- 旧中文");
    expect(text).toContain("++新中文");
    expect(text).not.toContain("\uFFFD");
  });

  test("combined segments keep ASCII-only content byte-identical", () => {
    const bytes = patch(
      "diff --cc a/merge.txt\n",
      "index 1111111,2222222..3333333\n",
      "--- a/merge.txt\n",
      "+++ b/merge.txt\n",
      "@@@ -1,1 -1,1 +1,1 @@@\n",
      "- ascii old\n",
      "++ascii new\n",
    );
    expect(transcodePatch(bytes, defaults)).toBe(builtinDecode(bytes));
  });

  test("rename segments probe via +++ path and decode content", () => {
    const text = transcodePatch(RENAME_SECTION, defaults);
    expect(text).toContain("+++ b/renamed.txt");
    expect(text).toContain("-旧内容");
    expect(text).toContain("+新内容");
  });

  test("mode-only segments need no probe and pass through", () => {
    expect(transcodePatch(encoder.encode(MODE_ONLY_SECTION), defaults)).toBe(
      MODE_ONLY_SECTION,
    );
  });

  test("submodule segments pass through (ASCII fast path)", () => {
    expect(transcodePatch(encoder.encode(SUBMODULE_SECTION), defaults)).toBe(
      SUBMODULE_SECTION,
    );
  });

  test("\\ No newline markers survive transcoding", () => {
    const text = transcodePatch(NOEOL_SECTION, defaults);
    expect(text).toContain("\\ No newline at end of file");
    expect(text).toContain("-旧中文(old)");
    expect(text).toContain("+新中文(new)");
    expect(text.split("\n").filter((l) => l.startsWith("\\")).length).toBe(2);
  });

  test("deleted segments fall back to the --- path for probing", () => {
    const text = transcodePatch(DELETED_SECTION, defaults);
    expect(text).toContain("+++ /dev/null");
    expect(text).toContain("-旧中文");
    expect(text).not.toContain("\uFFFD");
  });

  test("multiple hunks in one segment decode with one probe", () => {
    const text = transcodePatch(MULTI_HUNK_SECTION, defaults);
    expect(text).toContain("-旧一");
    expect(text).toContain("+新一");
    expect(text).toContain("-旧五");
    expect(text).toContain("+新五");
  });
});

describe("transcodePatch — encoding config", () => {
  test("overrides pin the encoding for a whole segment", () => {
    const settings = parseExtensionSettings({
      overrides: { "legacy/**/*.txt": "windows-1252" },
    });
    const text = transcodePatch(OVERRIDE_SECTION, settings);
    expect(text).toContain("ÖÐÎÄ"); // GBK bytes read as windows-1252
    expect(text).not.toContain("中文");
  });

  test("candidate order changes segment decoding", () => {
    const sjis = parseExtensionSettings({
      encodings: ["shift_jis"],
      overrides: { "sjis.txt": "shift_jis" },
    });
    const text = transcodePatch(SJIS_SECTION, sjis);
    expect(text).toContain("-日本語");
    expect(text).toContain("+こんにちは");
  });

  test("CJK ambiguity: default candidates decode SJIS bytes as GBK", () => {
    const text = transcodePatch(SJIS_SECTION, defaults);
    expect(text).not.toContain("日本語"); // gbk wins — documented limitation
  });
});

describe("transcodePatch — framing", () => {
  test("empty input → empty output", () => {
    expect(transcodePatch(new Uint8Array(0), defaults)).toBe("");
  });

  test("trailing newline is preserved", () => {
    const withNewline = patch(GBK_SECTION);
    expect(transcodePatch(withNewline, defaults).endsWith("\n")).toBe(true);
    const withoutNewline = patch(
      "diff --git a/gbk.txt b/gbk.txt\n",
      "@@ -1,1 +1,1 @@\n",
      "+",
      GBK_NEW,
    );
    const text = transcodePatch(withoutNewline, defaults);
    expect(text.endsWith("\n")).toBe(false);
    expect(text.endsWith("+新中文")).toBe(true);
  });

  test("mixed-repo patch: UTF-8 + GBK + binary + mode-only in one stream", () => {
    const bytes = patch(
      ASCII_SECTION,
      GBK_SECTION,
      BINARY_SECTION,
      MODE_ONLY_SECTION,
    );
    const text = transcodePatch(bytes, defaults);
    expect(text).not.toContain("\uFFFD");
    expect(text).toContain("-旧中文");
    expect(text).toContain("Binary files a/bin.dat and b/bin.dat differ");
    expect(text).toContain("old mode 100644");
    expect(text.split("diff --git ").length).toBe(5); // 4 segments + trailing split
  });
});

// ---------------------------------------------------------------------------
// ANSI (colorMoved) — git paints structural lines under --color=always (Q4)
// ---------------------------------------------------------------------------

const E = "\u001b[";

/** One git-painted structural line: bold paint, content, reset. */
const paint = (code: string, visible: string) => `${E}${code}m${visible}${E}m\n`;

/** What `git show --color=always --color-moved=zebra` emits for a GBK file. */
const ANSI_GBK_SECTION = patch(
  paint("1", "diff --git a/legacy.txt b/legacy.txt"),
  paint("1", "new file mode 100644"),
  paint("1", "index 0000000..abf3520"),
  paint("1", "--- /dev/null"),
  paint("1", "+++ b/legacy.txt"),
  paint("36", "@@ -0,0 +1 @@"),
  patch(`${E}32m+${E}m${E}32m`, GBK_NEIRONG_NEW, `${E}m\n`),
);

describe("transcodePatch — ANSI structural lines (colorMoved)", () => {
  test("colored segment headers still open a transcoded segment", () => {
    const text = transcodePatch(ANSI_GBK_SECTION, defaults);
    // git paints the sign and the content in separate spans:
    // `ESC[32m+ESC[m ESC[32m新内容ESC[m` — assert them separately.
    expect(text).toContain("\u001b[32m+\u001b[m");
    expect(text).toContain("新内容");
    expect(text).not.toContain("\uFFFD");
    // The paint itself survives (Q4 passthrough).
    expect(text).toContain("\u001b[32m");
    expect(text).toContain("\u001b[1mdiff --git a/legacy.txt b/legacy.txt\u001b[m");
  });

  test("colored two-sided hunks decode both sides", () => {
    const bytes = patch(
      paint("1", "diff --git a/gbk.txt b/gbk.txt"),
      paint("1", "index 3333333..4444444 100644"),
      paint("1", "--- a/gbk.txt"),
      paint("1", "+++ b/gbk.txt"),
      paint("36", "@@ -1,2 +1,2 @@"),
      patch(`${E}31m-`, GBK_OLD, `${E}m\n`),
      patch(`${E}32m+`, GBK_NEW, `${E}m\n`),
      patch(`${E}36m `, GBK_CONTEXT, `${E}m\n`),
    );
    const text = transcodePatch(bytes, defaults);
    expect(text).toContain("-旧中文");
    expect(text).toContain("+新中文");
    expect(text).toContain(" 上下文");
    expect(text).not.toContain("\uFFFD");
  });

  test("overrides still match through colored +++ headers", () => {
    const settings = parseExtensionSettings({ overrides: { "legacy.txt": "latin1" } });
    const text = transcodePatch(ANSI_GBK_SECTION, settings);
    // The override proved the file path was extracted under ANSI painting:
    // GBK bytes decode as windows-1252 instead of the default GBK probe.
    expect(text).toContain(
      new TextDecoder("windows-1252").decode(GBK_NEIRONG_NEW),
    );
    expect(text).not.toContain("新内容");
  });

  test("unterminated escape-only lines do not crash classification", () => {
    const bytes = patch(
      "diff --git a/x.txt b/x.txt\n",
      "@@ -1,1 +1,1 @@\n",
      "+a\n",
      "\u001b[3", // truncated CSI at end of stream
    );
    const text = transcodePatch(bytes, defaults);
    expect(text).toContain("+a");
  });
});
