/**
 * Unit tests for src/transcode.ts + src/config.ts (plan §9.1).
 *
 * Sample bytes:
 *   GBK       中文   = d6 d0 ce c4
 *   GBK       新中文 = d0 c2 d6 d0 ce c4
 *   Shift-JIS 日本語 = 93 fa 96 7b 8c ea
 *   Big5      繁體中文 = c1 63 c5 e9 a4 a4 a4 e5
 */
import { describe, expect, test } from "bun:test";
import {
  FALLBACK_ENCODING,
  defaultSettings,
  matchOverrides,
  parseExtensionSettings,
} from "../src/config";
import {
  detectEncoding,
  isPureAscii,
  stripAnsiEscapes,
  transcode,
} from "../src/transcode";

function hex(input: string): Uint8Array {
  const clean = input.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2)!, 16)!;
  }
  return out;
}

const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text);

const GBK_ZHONGWEN = hex("d6d0cec4"); // 中文
const GBK_XIN = hex("d0c2d6d0cec4"); // 新中文
const SJIS_JAPANESE = hex("93fa967b8cea"); // 日本語
const SJIS_KONNICHIWA = hex("82b182f182c982bf82cd"); // こんにちは
const BIG5_TRADITIONAL = hex("c163c5e9a4a4a4e5"); // 繁體中文

describe("transcode", () => {
  test("decodes GBK bytes to UTF-8 text", () => {
    expect(transcode(GBK_ZHONGWEN, "gbk")).toBe("中文");
    expect(transcode(GBK_XIN, "gbk")).toBe("新中文");
  });

  test("decodes Shift-JIS bytes", () => {
    expect(transcode(SJIS_JAPANESE, "shift_jis")).toBe("日本語");
    expect(transcode(SJIS_KONNICHIWA, "shift_jis")).toBe("こんにちは");
  });

  test("decodes Big5 bytes", () => {
    expect(transcode(BIG5_TRADITIONAL, "big5")).toBe("繁體中文");
  });

  test("passes UTF-8 through", () => {
    const bytes = utf8Bytes("中文 UTF-8 ✅");
    expect(transcode(bytes, "utf-8")).toBe("中文 UTF-8 ✅");
  });

  test("strips a UTF-8 BOM when decoding", () => {
    const withBom = new Uint8Array(3 + 5);
    withBom.set(hex("efbbbf"), 0);
    withBom.set(utf8Bytes("hello"), 3);
    expect(transcode(withBom, "utf-8")).toBe("hello");
  });

  test("decodes UTF-16LE with BOM", () => {
    const bytes = hex("fffe61006200"); // BOM + "ab"
    expect(transcode(bytes, "utf-16")).toBe("ab");
  });

  test("decodes UTF-16BE with BOM", () => {
    const bytes = hex("feff00610062"); // BOM + "ab"
    expect(transcode(bytes, "utf-16be")).toBe("ab");
  });

  test("empty bytes round-trip", () => {
    expect(transcode(new Uint8Array(0), "gbk")).toBe("");
  });

  test("pure ASCII fast path is encoding-independent", () => {
    const bytes = utf8Bytes("plain ascii 123");
    expect(isPureAscii(bytes)).toBe(true);
    expect(transcode(bytes, "gbk")).toBe("plain ascii 123");
    expect(transcode(bytes, "windows-1252")).toBe("plain ascii 123");
  });

  test("non-ASCII bytes are not pure ASCII", () => {
    expect(isPureAscii(GBK_ZHONGWEN)).toBe(false);
  });
});

describe("detectEncoding — probe chain", () => {
  const defaults = defaultSettings();

  test("empty bytes → utf-8", () => {
    expect(detectEncoding(new Uint8Array(0), "a.txt", defaults)).toBe("utf-8");
  });

  test("pure ASCII → utf-8", () => {
    expect(detectEncoding(utf8Bytes("hello"), "a.txt", defaults)).toBe("utf-8");
  });

  test("GBK bytes → gb18030 under default candidates", () => {
    expect(detectEncoding(GBK_ZHONGWEN, "a.txt", defaults)).toBe("gbk");
  });

  test("UTF-8 multi-byte → utf-8 via strict validation", () => {
    const bytes = utf8Bytes("中文内容");
    expect(detectEncoding(bytes, "a.txt", defaults)).toBe("utf-8");
  });

  test("UTF-8 BOM → utf-8", () => {
    const withBom = new Uint8Array(3 + 2);
    withBom.set(hex("efbbbf"), 0);
    withBom.set(utf8Bytes("hi"), 3);
    expect(detectEncoding(withBom, "a.txt", defaults)).toBe("utf-8");
  });

  test("UTF-16LE BOM → utf-16", () => {
    expect(detectEncoding(hex("fffe61006200"), "a.txt", defaults)).toBe("utf-16");
  });

  test("UTF-16BE BOM → utf-16be", () => {
    expect(detectEncoding(hex("feff00610062"), "a.txt", defaults)).toBe("utf-16be");
  });

  test("overrides win over everything, even valid UTF-8", () => {
    const settings = parseExtensionSettings({ overrides: { "钉死的.txt": "gbk" } });
    const utf8Chinese = utf8Bytes("中文");
    expect(detectEncoding(utf8Chinese, "钉死的.txt", settings)).toBe("gbk");
    // Same bytes elsewhere stay UTF-8.
    expect(detectEncoding(utf8Chinese, "别的.txt", settings)).toBe("utf-8");
  });
});

describe("detectEncoding — candidate order & fallback", () => {
  test("CJK ambiguity: candidate order decides (d6d0 decodes under gbk and big5)", () => {
    const gbkFirst = parseExtensionSettings({ encodings: ["gbk", "big5"] });
    const big5First = parseExtensionSettings({ encodings: ["big5", "gbk"] });
    expect(detectEncoding(GBK_ZHONGWEN, "a.txt", gbkFirst)).toBe("gbk");
    expect(detectEncoding(GBK_ZHONGWEN, "a.txt", big5First)).toBe("big5");
  });

  test("shift_jis bytes decode under shift_jis when listed", () => {
    const settings = parseExtensionSettings({ encodings: ["shift_jis"] });
    expect(detectEncoding(SJIS_JAPANESE, "a.txt", settings)).toBe("shift_jis");
  });

  test("candidates failing → fallback encoding", () => {
    // 0x81 0x20 is illegal in gbk/big5/shift_jis/euc-jp and UTF-8.
    const hopeless = hex("8120");
    const settings = parseExtensionSettings({ encodings: ["euc-kr"], fallback: "big5" });
    expect(detectEncoding(hopeless, "a.txt", settings)).toBe(FALLBACK_ENCODING);
  });

  test("fallback decoding wins when candidates fail", () => {
    // euc-kr decodes 8120? No — but windows-1252 always succeeds.
    const settings = parseExtensionSettings({
      encodings: ["euc-kr"],
      fallback: "windows-1252",
    });
    expect(detectEncoding(hex("8120"), "a.txt", settings)).toBe("windows-1252");
  });

  test("final fallback is latin1 and never throws", () => {
    const bytes = detectEncoding(hex("8120"), "a.txt", defaultSettings());
    expect(bytes).toBe("windows-1252"); // canonical name of latin1
    expect(transcode(hex("8120"), "windows-1252")).toBe("\u0081 ");
  });
});

describe("overrides matching (Q11 slash heuristic)", () => {
  const rules = parseExtensionSettings({
    overrides: {
      "legacy/**/*.txt": "latin1",
      "*.csv": "gbk",
      "*.{png,jpg}": "latin1",
    },
  }).overrides;

  test("glob with '/' targets the full review path", () => {
    expect(matchOverrides("legacy/a.txt", rules)?.encoding).toBe("windows-1252");
    expect(matchOverrides("legacy/x/y.txt", rules)?.encoding).toBe("windows-1252");
    expect(matchOverrides("other/legacy/a.txt", rules)).toBeNull();
    expect(matchOverrides("legacy/a.csv", rules)?.encoding).toBe("gbk"); // basename rule still applies
  });

  test("glob without '/' targets the file name at any depth", () => {
    expect(matchOverrides("a/b/deep.csv", rules)?.encoding).toBe("gbk");
    expect(matchOverrides("a.csv", rules)?.encoding).toBe("gbk");
  });

  test("brace alternation expands", () => {
    expect(matchOverrides("img/photo.jpg", rules)?.encoding).toBe("windows-1252");
    expect(matchOverrides("img/photo.png", rules)?.encoding).toBe("windows-1252");
    expect(matchOverrides("img/photo.webp", rules)).toBeNull();
  });

  test("longest glob wins across targets", () => {
    const mixed = parseExtensionSettings({
      overrides: { "a/**/*.txt": "gbk", "*.txt": "latin1" },
    }).overrides;
    expect(matchOverrides("a/b.txt", mixed)?.encoding).toBe("gbk");
    expect(matchOverrides("b.txt", mixed)?.encoding).toBe("windows-1252");
  });

  test("no rules → null", () => {
    expect(matchOverrides("a.txt", [])).toBeNull();
  });
});

describe("config parsing", () => {
  test("defaults when config is absent", () => {
    const settings = parseExtensionSettings(undefined);
    expect(settings.encodings).toEqual(["gbk", "big5", "shift_jis"]);
    expect(settings.fallback).toBe("gbk");
    expect(settings.overrides).toEqual([]);
  });

  test("labels are case-insensitive and deduped canonically", () => {
    const settings = parseExtensionSettings({
      encodings: ["GBK", "gb2312", "gbk", "Windows-1252"],
    });
    expect(settings.encodings).toEqual(["gbk", "windows-1252"]);
  });

  test("invalid values are dropped with notify, extension survives", () => {
    const messages: string[] = [];
    const settings = parseExtensionSettings(
      { encodings: ["utf-8", "gbk", "unknown-charset"], fallback: "utf-16" },
      (message) => messages.push(message),
    );
    expect(settings.encodings).toEqual(["gbk"]);
    expect(settings.fallback).toBe("gbk"); // default restored
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.some((m) => m.includes("unknown-charset"))).toBe(true);
  });

  test("non-array encodings falls back to defaults", () => {
    const settings = parseExtensionSettings({ encodings: "gbk" });
    expect(settings.encodings).toEqual(["gbk", "big5", "shift_jis"]);
  });
});

describe("ANSI handling (colorMoved prep, plan §4.7)", () => {
  test("stripAnsiEscapes removes CSI sequences", () => {
    const colored = utf8Bytes("\x1b[36m");
    const payload = GBK_ZHONGWEN;
    const reset = utf8Bytes("\x1b[m");
    const wrapped = new Uint8Array(
      colored.length + payload.length + reset.length,
    );
    wrapped.set(colored, 0);
    wrapped.set(payload, colored.length);
    wrapped.set(reset, colored.length + payload.length);
    const stripped = stripAnsiEscapes(wrapped);
    expect(Array.from(stripped)).toEqual(Array.from(GBK_ZHONGWEN));
  });

  test("detection ignores ANSI bytes", () => {
    const wrapped = utf8Bytes("\x1b[36m");
    const bytes = new Uint8Array(wrapped.length + GBK_ZHONGWEN.length + 3);
    bytes.set(wrapped, 0);
    bytes.set(GBK_ZHONGWEN, wrapped.length);
    bytes.set(utf8Bytes("\x1b[m"), wrapped.length + GBK_ZHONGWEN.length);
    expect(detectEncoding(bytes, "moved.txt", defaultSettings())).toBe("gbk");
  });

  test("transcode preserves ANSI sequences inside legacy content", () => {
    const wrapped = utf8Bytes("\x1b[36m");
    const bytes = new Uint8Array(wrapped.length + GBK_ZHONGWEN.length + 3);
    bytes.set(wrapped, 0);
    bytes.set(GBK_ZHONGWEN, wrapped.length);
    bytes.set(utf8Bytes("\x1b[m"), wrapped.length + GBK_ZHONGWEN.length);
    expect(transcode(bytes, "gbk")).toBe("\x1b[36m中文\x1b[m");
  });
});
