/**
 * Configuration parsing for `[extension.hunk-custom-encoding]` (plan §7).
 *
 * Pure functions only (ADR-0003): whitelist validation, defaults and the
 * overrides glob matcher (Q11 slash heuristic) live here so `transcode.ts`
 * consumes a fully validated `ExtensionSettings` without touching host state.
 *
 * Encoding names are normalized to one canonical representative per WHATWG
 * decoder (the "gbk"/"gb2312"/"gb18030" labels all share the GB18030
 * decoder and normalize to "gbk"; "latin1" maps to "windows-1252";
 * "cp866" maps to "ibm866"). Everything stored in `ExtensionSettings` is
 * guaranteed constructible at runtime.
 */

export type ConfigNotify = (message: string) => void;

/** A validated `overrides` entry. */
export interface OverrideRule {
  /** Original glob pattern as configured. */
  glob: string;
  /** Canonical encoding name (e.g. "gbk" for the labels "gbk"/"gb2312"). */
  encoding: string;
  /**
   * Slash heuristic (Q11): globs containing "/" target the full review
   * path; otherwise they target the file name at any depth.
   */
  target: "path" | "basename";
  /** Configuration order, the final tie-break. */
  order: number;
}

/** Fully validated extension settings handed to the transcode pipeline. */
export interface ExtensionSettings {
  /** Candidate encodings in priority order (canonical names). */
  encodings: string[];
  /** Fallback after the candidate list fails; final fallback is latin1. */
  fallback: string;
  overrides: OverrideRule[];
}

/**
 * Final fallback (Q8): "latin1" in docs; its WHATWG canonical name is
 * "windows-1252" — every byte is legal, so transcoding always succeeds.
 */
export const FALLBACK_ENCODING = "windows-1252";

/**
 * Canonical name per whitelist label (Q12, verified against Bun 1.3.13).
 * This map is also the whitelist: labels absent here are rejected.
 * `utf-8` is intentionally absent (strict validation covers it) and so are
 * `utf-16*` (git treats NUL bytes as binary; no content lines exist).
 * WHATWG decoders decode each alias identically (the "gbk"/"gb2312" labels
 * all map to the GB18030 decoder; Bun reports "gbk" for both). Pinning our
 * own map keeps returned names — and therefore `sourceCacheKey`s — stable
 * across runtime versions.
 */
const CANONICAL_BY_LABEL: Readonly<Record<string, Bun.Encoding>> = {
  gbk: "gbk",
  gb2312: "gbk",
  gb18030: "gbk",
  big5: "big5",
  shift_jis: "shift_jis",
  "euc-jp": "euc-jp",
  "euc-kr": "euc-kr",
  latin1: "windows-1252",
  "iso-8859-1": "windows-1252",
  "windows-1252": "windows-1252",
  "iso-8859-6": "iso-8859-6",
  "iso-8859-7": "iso-8859-7",
  "iso-8859-8": "iso-8859-8",
  "windows-1253": "windows-1253",
  "windows-1255": "windows-1255",
  "windows-1257": "windows-1257",
  "koi8-u": "koi8-u",
  ibm866: "ibm866",
  cp866: "ibm866",
};

/** Default candidate list, covering the primary CJK target repos (§7.1 A). */
const DEFAULT_CANDIDATE_LABELS = ["gbk", "big5", "shift_jis"] as const;
const DEFAULT_FALLBACK_LABEL = "gbk";

const MAX_CANDIDATES = 16;
const MAX_OVERRIDES = 256;
const MAX_GLOB_LENGTH = 1024;

/** Canonical name for a whitelist label, or null when unsupported. */
export function canonicalizeEncoding(label: string): string | null {
  const canonical = CANONICAL_BY_LABEL[label.trim().toLowerCase()];
  if (canonical === undefined) return null;
  try {
    // Runtime construct check (Q12): the whitelist is authoritative, but
    // never trust a name the current runtime cannot actually construct.
    new TextDecoder(canonical);
    return canonical;
  } catch {
    return null;
  }
}

/** Settings used when no (or partial) configuration is present. */
export function defaultSettings(): ExtensionSettings {
  return {
    encodings: uniqueCanonical(DEFAULT_CANDIDATE_LABELS),
    fallback: canonicalizeEncoding(DEFAULT_FALLBACK_LABEL) ?? FALLBACK_ENCODING,
    overrides: [],
  };
}

function uniqueCanonical(labels: readonly string[]): string[] {
  const out: string[] = [];
  for (const label of labels) {
    const canonical = canonicalizeEncoding(label);
    if (canonical !== null && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/**
 * Parse the extension's own config table (`hunk.config` for this
 * extension id, plan §7). Invalid values are dropped with an optional
 * `notify` message; the extension never fails as a whole.
 */
export function parseExtensionSettings(
  raw: unknown,
  notify?: ConfigNotify,
): ExtensionSettings {
  const settings = defaultSettings();
  if (raw === undefined || raw === null) return settings;
  if (typeof raw !== "object") {
    notify?.(
      "extension.hunk-custom-encoding: config table must be a table — using defaults",
    );
    return settings;
  }
  const record = raw as Record<string, unknown>;
  return {
    encodings: parseEncodings(record["encodings"], notify) ?? settings.encodings,
    fallback: parseFallback(record["fallback"], notify) ?? settings.fallback,
    overrides: parseOverrides(record["overrides"], notify),
  };
}

function parseEncodings(
  value: unknown,
  notify?: ConfigNotify,
): string[] | undefined {
  if (value === undefined) return undefined; // keep default
  if (!Array.isArray(value)) {
    notify?.(
      "extension.hunk-custom-encoding: encodings must be an array of strings — using defaults",
    );
    return undefined;
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item !== "string") {
      notify?.(
        `extension.hunk-custom-encoding: encodings[${i}] must be a string — ignored`,
      );
      continue;
    }
    if (out.length >= MAX_CANDIDATES) {
      notify?.(
        `extension.hunk-custom-encoding: encodings limited to ${MAX_CANDIDATES} entries — "${item}" ignored`,
      );
      break;
    }
    const canonical = canonicalizeEncoding(item);
    if (canonical === null) {
      notify?.(
        `extension.hunk-custom-encoding: encodings[${i}]: unsupported encoding "${item}" — ignored (see README whitelist; utf-8/utf-16 cannot be configured)`,
      );
      continue;
    }
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

function parseFallback(
  value: unknown,
  notify?: ConfigNotify,
): string | undefined {
  if (value === undefined) return undefined; // keep default
  if (typeof value !== "string") {
    notify?.(
      "extension.hunk-custom-encoding: fallback must be a string — using default",
    );
    return undefined;
  }
  const canonical = canonicalizeEncoding(value);
  if (canonical === null) {
    notify?.(
      `extension.hunk-custom-encoding: fallback: unsupported encoding "${value}" — using default`,
    );
    return undefined;
  }
  return canonical;
}

function parseOverrides(
  value: unknown,
  notify?: ConfigNotify,
): OverrideRule[] {
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    notify?.(
      "extension.hunk-custom-encoding: overrides must be a table of glob = encoding — ignored",
    );
    return [];
  }
  const out: OverrideRule[] = [];
  for (const [glob, rawEncoding] of Object.entries(value as Record<string, unknown>)) {
    if (out.length >= MAX_OVERRIDES) {
      notify?.(
        `extension.hunk-custom-encoding: overrides limited to ${MAX_OVERRIDES} entries — "${glob}" ignored`,
      );
      break;
    }
    const compiled = compileGlobToRegExp(glob);
    if (compiled === null) {
      notify?.(
        `extension.hunk-custom-encoding: overrides["${glob}"]: invalid glob pattern — entry ignored`,
      );
      continue;
    }
    if (typeof rawEncoding !== "string") {
      notify?.(
        `extension.hunk-custom-encoding: overrides["${glob}"] must map to a string encoding — entry ignored`,
      );
      continue;
    }
    const canonical = canonicalizeEncoding(rawEncoding);
    if (canonical === null) {
      notify?.(
        `extension.hunk-custom-encoding: overrides["${glob}"]: unsupported encoding "${rawEncoding}" — entry ignored (see README whitelist)`,
      );
      continue;
    }
    out.push({
      glob,
      encoding: canonical,
      // Slash heuristic (Q11): a glob containing "/" matches the full
      // review path; otherwise it matches the file name at any depth.
      target: glob.includes("/") ? "path" : "basename",
      order: out.length,
    });
  }
  return out;
}

/**
 * First override rule matching `path`, or null.
 * Longest glob wins; ties prefer "path" targets, then configuration order.
 */
export function matchOverrides(
  path: string,
  rules: readonly OverrideRule[],
): OverrideRule | null {
  let best: OverrideRule | null = null;
  for (const rule of rules) {
    const subject = rule.target === "basename" ? basenameOf(path) : path;
    if (!globMatches(rule.glob, subject)) continue;
    if (best === null || outranks(rule, best)) best = rule;
  }
  return best;
}

function outranks(candidate: OverrideRule, incumbent: OverrideRule): boolean {
  if (candidate.glob.length !== incumbent.glob.length) {
    return candidate.glob.length > incumbent.glob.length;
  }
  if (candidate.target !== incumbent.target) return candidate.target === "path";
  return candidate.order < incumbent.order;
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

// ---------------------------------------------------------------------------
// Glob matching: Bun-shell style (registerFileLanguage semantics), case
// sensitive, "/" as the review-path separator. Supports `*` (no "/"),
// `**` (crosses "/"), `?`, `[...]` classes and `{a,b}` alternation.
// ---------------------------------------------------------------------------

const globRegExpCache = new Map<string, RegExp | null>();

function globMatches(glob: string, subject: string): boolean {
  let regExp = globRegExpCache.get(glob);
  if (regExp === undefined) {
    regExp = compileGlobToRegExp(glob);
    globRegExpCache.set(glob, regExp);
  }
  return regExp !== null && regExp.test(subject);
}

/** Compile a glob to an anchored RegExp, or null when invalid. */
export function compileGlobToRegExp(glob: string): RegExp | null {
  const pattern = glob.trim();
  if (!pattern || pattern.length > MAX_GLOB_LENGTH) return null;
  const sources: string[] = [];
  for (const expanded of braceExpand(pattern)) {
    const source = globToRegExpSource(expanded);
    if (source === null) return null;
    sources.push(source);
  }
  try {
    return new RegExp(`^(?:${sources.join("|")})$`);
  } catch {
    return null;
  }
}

const REGEX_SPECIAL: ReadonlySet<string> = new Set([
  ".",
  "*",
  "+",
  "?",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  "/",
  "\\",
]);

function reEscape(char: string): string {
  return REGEX_SPECIAL.has(char) ? `\\${char}` : char;
}

/**
 * Expand `{a,b}` alternation (nesting allowed). A brace group without a
 * top-level comma (`{abc}`) and unbalanced braces stay literal, matching
 * shell behavior.
 */
function braceExpand(pattern: string): string[] {
  let open = -1;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") {
      i++;
      continue;
    }
    if (pattern[i] === "{") {
      open = i;
      break;
    }
  }
  if (open < 0) return [pattern];

  const alts: string[] = [];
  let depth = 0;
  let altStart = open + 1;
  let close = -1;
  for (let i = open + 1; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\") {
      i++;
      continue;
    }
    if (char === "{") {
      depth++;
    } else if (char === "}") {
      if (depth === 0) {
        close = i;
        break;
      }
      depth--;
    } else if (char === "," && depth === 0) {
      alts.push(pattern.slice(altStart, i));
      altStart = i + 1;
    }
  }
  if (close < 0) return [pattern]; // unbalanced → literal
  alts.push(pattern.slice(altStart, close));
  if (alts.length === 1) return [pattern]; // `{abc}` → literal

  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const out: string[] = [];
  for (const alt of alts) {
    for (const altExpanded of braceExpand(alt)) {
      for (const tailExpanded of braceExpand(tail)) {
        out.push(head + altExpanded + tailExpanded);
      }
    }
  }
  return out;
}

function globToRegExpSource(glob: string): string | null {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const char = glob[i]!;
    if (char === "\\") {
      const next = glob[i + 1];
      if (next === undefined) return null; // dangling escape → invalid
      out += reEscape(next);
      i += 2;
      continue;
    }
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?"; // `**/` → zero or more directories
          i += 3;
          continue;
        }
        out += ".*"; // standalone `**` crosses "/"
        i += 2;
        continue;
      }
      out += "[^/]*";
      i++;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    if (char === "[") {
      const parsed = parseCharClass(glob, i);
      if (parsed === null) {
        out += reEscape(char); // unterminated class → literal "["
        i++;
        continue;
      }
      out += parsed;
      i = classEndIndex(glob, i) + 1;
      continue;
    }
    if (char === "/") {
      if (glob.startsWith("/**", i) && i + 3 === glob.length) {
        out += "(?:/.*)?"; // trailing `/**` → zero or more entries
        i += 3;
        continue;
      }
      out += "/";
      i++;
      continue;
    }
    out += reEscape(char);
    i++;
  }
  return out;
}

function parseCharClass(glob: string, start: number): string | null {
  let inner = "";
  let negation = "";
  let j = start + 1;
  if (glob[j] === "!" || glob[j] === "^") {
    negation = "^";
    j++;
  }
  if (glob[j] === "]") {
    inner += reEscape("]");
    j++;
  }
  while (j < glob.length && glob[j] !== "]") {
    if (glob[j] === "\\") {
      const next = glob[j + 1];
      if (next === undefined) return null;
      inner += reEscape(next);
      j += 2;
      continue;
    }
    inner += glob[j];
    j++;
  }
  if (j >= glob.length) return null; // unterminated
  return `[${negation}${inner}]`;
}

function classEndIndex(glob: string, start: number): number {
  let j = start + 1;
  if (glob[j] === "!" || glob[j] === "^") j++;
  if (glob[j] === "]") j++;
  while (j < glob.length && glob[j] !== "]") {
    if (glob[j] === "\\") j++;
    j++;
  }
  return j;
}
