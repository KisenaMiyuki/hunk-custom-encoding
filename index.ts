/**
 * hunk-custom-encoding entry point (plan §6, M0 remainder).
 *
 * Wraps the built-in Git adapter surface with byte-accurate transcoding so
 * Hunk can display non-UTF-8 (GBK/Shift-JIS/Big5/…) diffs. Registration
 * takes over every git repository via `detectionPriority` above the
 * built-in baseline; the diff semantics are replicated bit-for-bit
 * (ADR-0004) with the decode step replaced (ADR-0001).
 */

import type { HunkExtensionAPI } from "hunkdiff/extension";
import { parseExtensionSettings } from "./src/config";
import { createEncodingGitAdapter } from "./src/adapter";

const factory = (hunk: HunkExtensionAPI): void => {
  // `hunk.config` is this extension's own `[extension.hunk-custom-encoding]`
  // table, layered user-then-repo (untrusted input — see plan §7 trust note).
  // Invalid values are dropped with a diagnostic line, never fatal.
  const settings = parseExtensionSettings(hunk.config, (message) => hunk.log(message));
  hunk.registerVcsAdapter(createEncodingGitAdapter(settings));
};

export default factory;
