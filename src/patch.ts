/**
 * Patch byte stream → UTF-8 text (plan §4).
 *
 * The stream is split into patch segments (patch 段) at `diff --git` /
 * `diff --cc` boundaries. Within a normal segment:
 *
 *   - header lines (before the first `@@`): decoded as UTF-8 — always safe
 *     because `-c core.quotePath=true` octal-escapes non-ASCII paths (Q2);
 *   - `@@` hunk headers and `\ No newline at end of file` markers: ASCII,
 *     identical either way;
 *   - content lines (content 行, `+` / `-` / space prefixed): decoded with
 *     the encoding probed from that segment's content bytes. ANSI escape
 *     sequences (colorMoved, M3) are ASCII and survive legacy decoders
 *     untouched (Q4) — and because git paints *structural* lines under
 *     `--color=always` as well, every prefix match (segment headers, `@@`
 *     hunk headers, `+++`/`---` file headers) skips leading ANSI escapes
 *     before matching.
 *
 * Binary segments and combined (`diff --cc`) segments pass through with
 * plain UTF-8 decoding — the same bytes the built-in adapter would hand to
 * Hunk (Q10).
 */

import { type ExtensionSettings } from "./config";
import {
  UTF8_ENCODING,
  detectEncoding,
  isPureAscii,
  stripAnsiEscapes,
  transcode,
} from "./transcode";

const ESC = 0x1b;
const LEFT_BRACKET = 0x5b;
const PLUS = 0x2b;
const MINUS = 0x2d;
const SPACE = 0x20;
const BACKSLASH = 0x5c;

const DIFF_GIT_PREFIX = "diff --git ";
const DIFF_CC_PREFIX = "diff --cc ";
const DIFF_COMBINED_PREFIX = "diff --combined ";
const PLUS_FILE_PREFIX = "+++ ";
const MINUS_FILE_PREFIX = "--- ";
const HUNK_HEADER_PREFIX = "@@ ";
const DEV_NULL = "/dev/null";

type SectionKind = "normal" | "combined";

interface Section {
  kind: SectionKind;
  /** Index into the lines array (inclusive). */
  start: number;
  /** Index into the lines array (exclusive). */
  end: number;
}

/** Decode a line as UTF-8 (lenient — matches built-in adapter behavior). */
function lineToText(line: Uint8Array): string {
  // Pure-ASCII lines skip the decoder (fast path).
  return transcode(line, UTF8_ENCODING);
}

function asciiStartsWith(line: Uint8Array, prefix: string): boolean {
  if (line.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (line[i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Byte index of the first non-ANSI-escape byte, skipping leading CSI
 * sequences (`ESC[...m`). Returns -1 when the line is only escapes.
 */
function ansiSkipIndex(line: Uint8Array): number {
  let i = 0;
  while (i + 1 < line.length && line[i] === ESC && line[i + 1] === LEFT_BRACKET) {
    let j = i + 2;
    while (j < line.length && (line[j]! < 0x40 || line[j]! > 0x7e)) j++;
    if (j >= line.length) return -1;
    i = j + 1;
  }
  return i < line.length ? i : -1;
}

/**
 * ASCII prefix match on the *visible* bytes, skipping leading ANSI escapes
 * (Q4): under `--color=always` git paints every structural line too —
 * `ESC[1mdiff --git …ESC[m`, `ESC[36m@@ …ESC[m`, `ESC[1m+++ …ESC[m` — so
 * plain byte matching would misfile whole segments as passthrough prelude.
 */
function visibleStartsWith(line: Uint8Array, prefix: string): boolean {
  const start = ansiSkipIndex(line);
  if (start < 0) return false;
  if (line.length - start < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (line[start + i] !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * First classification byte of a line, skipping leading ANSI CSI escapes
 * (colorMoved wraps whole lines: `ESC[36m+content ESC[m`).
 * Returns -1 when the line is only (unterminated) escapes.
 */
function firstContentByte(line: Uint8Array): number {
  const start = ansiSkipIndex(line);
  return start < 0 ? -1 : line[start]!;
}

type ContentClass = "content" | "noeol" | "other";

/** Classify a hunk body line by its (post-ANSI) prefix byte. */
function classifyHunkLine(line: Uint8Array): ContentClass {
  const byte = firstContentByte(line);
  if (byte < 0) return "other";
  if (byte === BACKSLASH) return "noeol";
  if (byte === PLUS || byte === MINUS || byte === SPACE) return "content";
  return "other";
}

/**
 * Extract `+++ b/<path>` (falling back to `--- a/<path>`), stripping the
 * `a/` / `b/` prefix once (unified diff `-p1` semantics). Returns null for
 * segments without file paths (mode-only changes).
 */
function extractTargetPath(lines: readonly Uint8Array[]): string | null {
  let plus: string | null = null;
  let minus: string | null = null;
  for (const line of lines) {
    if (plus === null && visibleStartsWith(line, PLUS_FILE_PREFIX)) {
      plus = parsePathLine(line, PLUS_FILE_PREFIX.length);
    } else if (minus === null && visibleStartsWith(line, MINUS_FILE_PREFIX)) {
      minus = parsePathLine(line, MINUS_FILE_PREFIX.length);
    }
    if (plus !== null && minus !== null) break;
  }
  if (plus !== null && plus !== DEV_NULL) return stripDiffPrefix(plus);
  if (minus !== null && minus !== DEV_NULL) return stripDiffPrefix(minus);
  return null;
}

/**
 * Decode the visible text of one file-header line after `offset` characters
 * of visible content. ANSI escapes are stripped first, so colorMoved paint
 * (`ESC[1m+++ b/pESC[m`) leaves only the real path text — the trailing reset
 * escape would otherwise glue itself onto the path and break overrides.
 * Raw 0x1b never appears in real paths: `core.quotePath` octal-escapes them.
 */
function parsePathLine(line: Uint8Array, offset: number): string | null {
  let text = lineToText(stripAnsiEscapes(line)).slice(offset);
  const tab = text.indexOf("\t");
  if (tab >= 0) text = text.slice(0, tab);
  // core.quotePath quotes paths containing non-ASCII bytes.
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1);
  }
  return text;
}

function stripDiffPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

/** Concatenate content-line bytes for the encoding probe (plan §4). */
function collectProbeBytes(
  lines: readonly Uint8Array[],
  contentIndexes: readonly number[],
): Uint8Array {
  let total = 0;
  for (const index of contentIndexes) total += lines[index]!.length;
  const probe = new Uint8Array(total);
  let offset = 0;
  for (const index of contentIndexes) {
    probe.set(lines[index]!, offset);
    offset += lines[index]!.length;
  }
  return probe;
}

/** Rebuild one normal (unified) segment with per-line transcoding. */
function transcodeNormalSection(
  lines: readonly Uint8Array[],
  settings: ExtensionSettings,
): string {
  // Fast path: an all-ASCII segment is emitted unchanged (plan §4.4).
  let allAscii = true;
  for (const line of lines) {
    if (!isPureAscii(line)) {
      allAscii = false;
      break;
    }
  }
  if (allAscii) return joinLines(lines);

  const targetPath = extractTargetPath(lines) ?? "";

  // Locate the first hunk header; everything from there on is hunk body.
  let firstHunk = -1;
  for (let i = 0; i < lines.length; i++) {
    if (visibleStartsWith(lines[i]!, HUNK_HEADER_PREFIX)) {
      firstHunk = i;
      break;
    }
  }

  const out: string[] = [];
  const contentIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (firstHunk < 0 || i < firstHunk) {
      out.push(lineToText(line)); // header line — ASCII under quotePath
      continue;
    }
    const cls = classifyHunkLine(line);
    if (cls === "content") {
      contentIndexes.push(i);
      out.push(""); // placeholder, replaced below
    } else if (cls === "noeol") {
      out.push(lineToText(line)); // ASCII marker
    } else {
      out.push(lineToText(line)); // defensive: passthrough
    }
  }

  let encoding = UTF8_ENCODING;
  if (contentIndexes.length > 0) {
    const probe = collectProbeBytes(lines, contentIndexes);
    encoding = detectEncoding(probe, targetPath, settings);
    for (const index of contentIndexes) {
      out[index] = transcode(lines[index]!, encoding);
    }
  }
  return joinLines(out);
}

function joinLines(lines: readonly (string | Uint8Array)[]): string {
  let text = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i > 0) text += "\n";
    text += typeof line === "string" ? line : lineToText(line);
  }
  return text;
}

/**
 * Transcode a raw patch byte stream to UTF-8 text (plan §4).
 *
 * `settings` is the parsed `[extension.hunk-custom-encoding]` config.
 */
export function transcodePatch(
  bytes: Uint8Array,
  settings: ExtensionSettings,
): string {
  if (bytes.length === 0) return "";
  const lines = splitLines(bytes);
  const trailingNewline = bytes[bytes.length - 1] === 0x0a;

  const parts: string[] = [];

  // Prelude: lines before the first segment header (passthrough).
  let cursor = 0;
  while (cursor < lines.length && !isSectionHeader(lines[cursor]!)) cursor++;
  if (cursor > 0) parts.push(joinLines(lines.slice(0, cursor)));

  // Walk the segments.
  while (cursor < lines.length) {
    const kind = visibleStartsWith(lines[cursor]!, DIFF_GIT_PREFIX)
      ? "normal"
      : "combined";
    let end = cursor + 1;
    while (end < lines.length && !isSectionHeader(lines[end]!)) end++;
    const segment = lines.slice(cursor, end);
    parts.push(
      kind === "normal"
        ? transcodeNormalSection(segment, settings)
        : joinLines(segment), // combined: passthrough (Q10)
    );
    cursor = end;
  }

  let text = parts.join("\n");
  if (trailingNewline) text += "\n";
  return text;
}

function isSectionHeader(line: Uint8Array): boolean {
  return (
    visibleStartsWith(line, DIFF_GIT_PREFIX) ||
    visibleStartsWith(line, DIFF_CC_PREFIX) ||
    visibleStartsWith(line, DIFF_COMBINED_PREFIX)
  );
}

/** Split into lines (byte views, no trailing "\n"); CRLF stays in-line. */
function splitLines(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      lines.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < bytes.length) lines.push(bytes.subarray(start));
  return lines;
}
