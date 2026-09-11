// packages/hunk/src/extension-api/keys.ts
var NAMED_KEYS = new Set([
  "escape",
  "tab",
  "space",
  "return",
  "enter",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`)
]);
var MODIFIER_TOKENS = {
  ctrl: "ctrl",
  control: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  alt: "option",
  option: "option",
  shift: "shift"
};
function parseKeyChord(chord) {
  const tokens = chord.split("+").map((token) => token.trim()).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return chord.trim() === "+" ? { base: "+", ctrl: false, meta: false, option: false, shift: false } : { error: `Empty key chord "${chord}"` };
  }
  const parsed = {
    base: "",
    ctrl: false,
    meta: false,
    option: false,
    shift: false
  };
  for (const [index, token] of tokens.entries()) {
    const modifier = MODIFIER_TOKENS[token.toLowerCase()];
    if (modifier && index < tokens.length - 1) {
      parsed[modifier] = true;
      continue;
    }
    if (index !== tokens.length - 1) {
      return { error: `Unknown modifier "${token}" in key chord "${chord}"` };
    }
    if (token.length === 1) {
      if (token !== token.toLowerCase() && token !== token.toUpperCase()) {
        return { error: `Unusable key "${token}" in key chord "${chord}"` };
      }
      if (/[A-Z]/.test(token)) {
        parsed.shift = true;
        parsed.base = token.toLowerCase();
      } else {
        parsed.base = token;
      }
      continue;
    }
    const named = token.toLowerCase();
    if (!NAMED_KEYS.has(named)) {
      return { error: `Unknown key "${token}" in key chord "${chord}"` };
    }
    parsed.base = named;
  }
  if (parsed.shift && !NAMED_KEYS.has(parsed.base) && !isLetterBase(parsed.base)) {
    return {
      error: `Key chord "${chord}" uses shift with "${parsed.base}"; ` + `bind the shifted character itself instead (e.g. "!" rather than "shift+1")`
    };
  }
  return parsed;
}
function isLetterBase(base) {
  return base.length === 1 && /[a-z]/.test(base);
}
function matchesControlCharacter(parsed, key) {
  if (!parsed.ctrl || parsed.meta || parsed.option || parsed.shift)
    return false;
  if (!isLetterBase(parsed.base))
    return false;
  if (key.name || key.meta || key.option || key.shift)
    return false;
  return key.sequence === String.fromCharCode(parsed.base.charCodeAt(0) - 96);
}
function matchesNamedKey(base, key) {
  const name = key.name?.toLowerCase();
  if (name === base) {
    return true;
  }
  if (base === "return" && name === "enter" || base === "enter" && name === "return") {
    return true;
  }
  return base === "space" && (name === " " || key.sequence === " ");
}
function matchesModifiers(parsed, key) {
  if (Boolean(key.ctrl) !== parsed.ctrl) {
    return false;
  }
  const meta = Boolean(key.meta);
  const option = Boolean(key.option);
  if (parsed.option && !parsed.meta) {
    return option || meta && key.source !== "kitty";
  }
  return meta === parsed.meta && option === parsed.option;
}
function matchesKeyChord(parsed, key) {
  if (matchesControlCharacter(parsed, key)) {
    return true;
  }
  if (!matchesModifiers(parsed, key)) {
    return false;
  }
  if (NAMED_KEYS.has(parsed.base)) {
    return matchesNamedKey(parsed.base, key) && Boolean(key.shift) === parsed.shift;
  }
  if (isLetterBase(parsed.base)) {
    if (parsed.shift) {
      return key.sequence === parsed.base.toUpperCase() || key.name === parsed.base && Boolean(key.shift);
    }
    return (key.name === parsed.base || key.sequence === parsed.base) && !key.shift;
  }
  return key.sequence === parsed.base || key.name === parsed.base;
}
function matchesKey(chord, key) {
  const parsed = parseKeyChord(chord);
  return "error" in parsed ? false : matchesKeyChord(parsed, key);
}
// packages/hunk/src/extension-api/types.ts
var HUNK_EXTENSION_API_VERSION = 25;
var HUNK_EXTENSION_USER_ERROR_NAME = "HunkExtensionUserError";

class HunkExtensionUserError extends Error {
  suggestions;
  constructor(message, { suggestions = [] } = {}) {
    super(message);
    this.name = HUNK_EXTENSION_USER_ERROR_NAME;
    this.suggestions = [...suggestions];
  }
}
var HUNK_VCS_DETECTION_BASELINE_PRIORITY = 0;
var HUNK_CORE_VCS_DETECTION_PRIORITY = HUNK_VCS_DETECTION_BASELINE_PRIORITY;
var HUNK_DEFAULT_VCS_DETECTION_PRIORITY = -100;
export {
  HUNK_CORE_VCS_DETECTION_PRIORITY,
  HUNK_DEFAULT_VCS_DETECTION_PRIORITY,
  HUNK_EXTENSION_API_VERSION,
  HUNK_EXTENSION_USER_ERROR_NAME,
  HUNK_VCS_DETECTION_BASELINE_PRIORITY,
  HunkExtensionUserError,
  matchesKey,
  matchesKeyChord,
  parseKeyChord
};
