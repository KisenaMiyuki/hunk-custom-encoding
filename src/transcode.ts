/**
 * Encoding detection + byte → UTF-8 transcoding (plan §5).
 *
 * Pure functions (ADR-0003). The detection chain is:
 *   overrides → BOM → strict UTF-8 validation → candidate list →
 *   fallback → latin1 (final fallback, Q8 — never fails).
 *
 * All returned encoding names are WHATWG canonical names that are always
 * constructible, so `transcode` never throws on its own.
 */

import {
  FALLBACK_ENCODING,
  matchOverrides,
  type ExtensionSettings,
} from "./config";

export const UTF8_ENCODING = "utf-8";

/**
 * TextDecoder instance pool (plan R5): decoders are stateless per call in
 * non-stream mode, so one instance per (name, fatal) pair is enough.
 */
const decoderPool = new Map<string, TextDecoder>();

function getDecoder(name: string, fatal: boolean): TextDecoder | null {
  const key = `${fatal ? "fatal" : "lenient"}:${name}`;
  let decoder = decoderPool.get(key);
  if (decoder === undefined) {
    try {
      // Label validity is our responsibility (the canonical map in
      // config.ts only emits known-good names); the catch guards anyway.
      decoder = new TextDecoder(name as Bun.Encoding, { fatal });
    } catch {
      return null; // unknown encoding label
    }
    decoderPool.set(key, decoder);
  }
  return decoder;
}

function decodeLenient(bytes: Uint8Array, name: string): string {
  const decoder = getDecoder(name, false);
  return decoder ? decoder.decode(bytes) : "";
}

/** True when the bytes decode without error under a fatal decoder. */
function decodesFully(bytes: Uint8Array, name: string): boolean {
  const decoder = getDecoder(name, true);
  if (!decoder) return false;
  try {
    decoder.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** True when every byte is < 0x80 (plan §4.4 fast path). */
export function isPureAscii(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i]! >= 0x80) return false;
  }
  return true;
}

/**
 * Git's binary heuristic: any NUL byte in the leading 8000 bytes (plan §6.2 —
 * binary sources are declined instead of transcoded).
 */
export function isLikelyBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * Remove ANSI CSI escape sequences (`ESC [ … final`) so colorMoved output
 * does not pollute the probe bytes (plan §4.7). Pure-ASCII input is
 * returned as-is.
 */
export function stripAnsiEscapes(bytes: Uint8Array): Uint8Array {
  let firstEscape = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x1b) {
      firstEscape = i;
      break;
    }
  }
  if (firstEscape < 0) return bytes;

  const out = new Uint8Array(bytes.length);
  out.set(bytes.subarray(0, firstEscape), 0);
  let written = firstEscape;
  let i = firstEscape;
  while (i < bytes.length) {
    const byte = bytes[i]!;
    if (
      byte === 0x1b &&
      i + 1 < bytes.length &&
      bytes[i + 1] === 0x5b // "["
    ) {
      // Skip to the CSI final byte (0x40–0x7e), typically "m".
      let j = i + 2;
      while (j < bytes.length && (bytes[j]! < 0x40 || bytes[j]! > 0x7e)) j++;
      if (j >= bytes.length) break; // unterminated escape → drop tail
      i = j + 1;
      continue;
    }
    out[written++] = byte;
    i++;
  }
  return out.subarray(0, written);
}

function detectBom(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return UTF8_ENCODING;
  }
  // The "utf-16" label sniffs and strips the LE BOM.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16";
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be";
  }
  return null;
}

function isStrictUtf8(bytes: Uint8Array): boolean {
  return decodesFully(bytes, UTF8_ENCODING);
}

/**
 * Decide the encoding for a set of content bytes (plan §5).
 *
 * `bytes` should be the file's content bytes only — for patch segments the
 * caller concatenates the content lines and strips ANSI escapes first.
 * `path` is the review path used for `overrides` matching.
 * Returns a canonical encoding name.
 */
export function detectEncoding(
  bytes: Uint8Array,
  path: string,
  settings: ExtensionSettings,
): string {
  // 1. Overrides are authoritative (plan §5.1).
  const override = matchOverrides(path, settings.overrides);
  if (override) return override.encoding;

  // 2. BOM detection.
  const bom = detectBom(bytes);
  if (bom) return bom;

  const probe = stripAnsiEscapes(bytes);

  // 3. Strict UTF-8 validation → passthrough.
  if (isStrictUtf8(probe)) return UTF8_ENCODING;

  // 4. Candidate list in configured order (fatal decode must succeed).
  for (const encoding of settings.encodings) {
    if (decodesFully(probe, encoding)) return encoding;
  }

  // 5. Fallback (fatal attempt), 6. latin1 never fails (Q8).
  if (settings.fallback !== FALLBACK_ENCODING && decodesFully(probe, settings.fallback)) {
    return settings.fallback;
  }
  return FALLBACK_ENCODING;
}

/**
 * Decode bytes to UTF-8 text using `encoding` (canonical name).
 * Pure-ASCII input bypasses the decoder entirely (plan §4.4 fast path) —
 * ASCII decodes identically under every ASCII-compatible encoding.
 */
export function transcode(bytes: Uint8Array, encoding: string): string {
  if (isPureAscii(bytes)) return decodeLenient(bytes, UTF8_ENCODING);
  const decoder = getDecoder(encoding, false);
  if (decoder) return decoder.decode(bytes);
  // Should be unreachable via detectEncoding; latin1 keeps output flowing.
  return decodeLenient(bytes, FALLBACK_ENCODING);
}
