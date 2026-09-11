/**
 * The key-chord grammar, published as part of `hunkdiff/extension`.
 *
 * A chord is the textual form a binding is declared in — `"s"`, `"G"`,
 * `"ctrl+r"`, `"f10"`, `"["`. Hunk's own shortcuts, extension
 * `registerCommand` bindings, and the user's `[keybindings]` config table all
 * speak this one grammar, and extension components that need their own internal
 * keys match with it too, instead of hand-reading key events.
 *
 * Every module the `hunkdiff/extension` entry reaches is published by
 * declaration emission, so this file reaches nothing but the contract itself:
 * its one import is a type-only import of `./types`, the other published
 * module, and no Hunk internal is reachable from either. `ExtensionKeyEvent`
 * lives there because the file-view mode contract needs it too; it is declared
 * structurally rather than pulled from OpenTUI, so a component can pass the
 * event it was handed straight through.
 */
import type { ExtensionKeyEvent } from "./types.js";
export type { ExtensionKeyEvent };
/** Modifier-normalized description of one parsed chord. */
export interface ParsedKeyChord {
    /** The base key: a named key (`escape`, `f10`, `pageup`) or one character. */
    base: string;
    ctrl: boolean;
    meta: boolean;
    option: boolean;
    shift: boolean;
}
/**
 * Parse one chord string, or explain why it cannot be a binding.
 *
 * `"G"` means shift+g, matching how terminals report it; multi-character bases
 * must be known named keys so a typo like `"ctlr+s"` or `"f13"` is refused at
 * registration instead of silently never firing.
 */
export declare function parseKeyChord(chord: string): ParsedKeyChord | {
    error: string;
};
/**
 * Report whether one key event is the parsed chord.
 *
 * Letters compare against `key.name` with an exact shift requirement, and the
 * shifted form also matches by uppercase `sequence` for terminals that report
 * `G` without a shift flag. Symbol bases compare by `sequence` and ignore the
 * shift flag entirely — `{` needs shift to type on most layouts, and whether
 * the terminal reports that is not the binding's business; the parser refuses
 * `shift+<symbol>` chords outright, so ignoring the flag here is consistent
 * rather than lossy.
 *
 * A plain `ctrl+<letter>` chord additionally matches the bare C0 control
 * character the combination is sent as, for events from sources that do not
 * decode it — see {@link matchesControlCharacter} for who those are, why
 * Hunk's own keypresses take the normal path instead, and why a named event
 * (Tab, Enter) is never claimed by the fallback.
 */
export declare function matchesKeyChord(parsed: ParsedKeyChord, key: ExtensionKeyEvent): boolean;
/**
 * Report whether one key event is the chord, parsing the chord on the way.
 *
 * The convenience form for extension UI: a component with internal keys asks
 * `matchesKey("ctrl+n", key)` rather than reading modifier flags itself, and
 * gets exactly the matching rules Hunk's own shortcuts use. An unparsable chord
 * matches nothing — a typo is a binding that never fires, never one that
 * swallows unrelated keys.
 */
export declare function matchesKey(chord: string, key: ExtensionKeyEvent): boolean;
