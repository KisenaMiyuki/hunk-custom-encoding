/**
 * Unit tests for src/git.ts + src/endpoints.ts pure helpers (plan §9.1).
 */
import { describe, expect, test } from "bun:test";
import { writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HunkExtensionUserError,
  type ExtensionVcsDiffInput,
  type ExtensionVcsShowInput,
  type ExtensionVcsStashShowInput,
} from "hunkdiff/extension";
import {
  DIFF_PREFIX_NORMALIZATION_ARGS,
  GIT_MOVED_LINE_COLOR_CONFIG,
  buildGitDiffArgs,
  buildGitDiffNumstatArgs,
  buildGitNoIndexDiffArgs,
  buildGitShowArgs,
  buildGitStashShowArgs,
  buildGitStatusArgs,
  commandLabel,
  describeDiffRange,
  normalizeGitColorMovedMode,
  parseGitNumstat,
  parseUntrackedFilePaths,
  translateGitExitFailure,
} from "../src/git";
import { parseSymmetricDiffRange } from "../src/endpoints";
import { statSignature } from "../src/adapter";

const diffInput = (overrides: Partial<ExtensionVcsDiffInput> = {}): ExtensionVcsDiffInput => ({
  kind: "vcs",
  staged: false,
  options: {},
  ...overrides,
});

const showInput = (overrides: Partial<ExtensionVcsShowInput> = {}): ExtensionVcsShowInput => ({
  kind: "show",
  options: {},
  ...overrides,
});

const stashInput = (
  overrides: Partial<ExtensionVcsStashShowInput> = {},
): ExtensionVcsStashShowInput => ({
  kind: "stash-show",
  options: {},
  ...overrides,
});

describe("buildGitDiffArgs", () => {
  test("plain working-tree diff matches the built-in flag set", () => {
    expect(buildGitDiffArgs(diffInput())).toEqual([
      ...DIFF_PREFIX_NORMALIZATION_ARGS,
      "diff",
      "--no-ext-diff",
      "--find-renames",
      "--no-color",
    ]);
  });

  test("staged adds --staged before pathspecs", () => {
    expect(buildGitDiffArgs(diffInput({ staged: true }))).toEqual([
      ...DIFF_PREFIX_NORMALIZATION_ARGS,
      "diff",
      "--no-ext-diff",
      "--find-renames",
      "--no-color",
      "--staged",
    ]);
  });

  test("range passes through verbatim", () => {
    const args = buildGitDiffArgs(diffInput({ range: "main...feature" }));
    expect(args).toContain("main...feature");
  });

  test("rangeEndpoints join into A..B", () => {
    const args = buildGitDiffArgs(
      diffInput({ rangeEndpoints: { from: "a", to: "b" } } as Partial<ExtensionVcsDiffInput>),
    );
    expect(args).toContain("a..b");
  });

  test("pathspecs land after --", () => {
    const args = buildGitDiffArgs(diffInput({ pathspecs: ["src/**", "*.md"] }));
    const separator = args.indexOf("--");
    expect(separator).toBeGreaterThan(0);
    expect(args.slice(separator + 1)).toEqual(["src/**", "*.md"]);
  });

  test("excluded pathspecs append :(exclude) entries", () => {
    const args = buildGitDiffArgs(diffInput({ pathspecs: ["src/**"] }), ["big.txt"]);
    const separator = args.indexOf("--");
    expect(args.slice(separator + 1)).toEqual(["src/**", ":(exclude)big.txt"]);
  });

  test("excluded pathspecs without user pathspecs still add --", () => {
    const args = buildGitDiffArgs(diffInput(), ["big.txt"]);
    const separator = args.indexOf("--");
    expect(args.slice(separator + 1)).toEqual([":(exclude)big.txt"]);
  });

  test("refuses option-like revisions", () => {
    expect(() => buildGitDiffArgs(diffInput({ range: "--output=/tmp/x" }))).toThrow(
      HunkExtensionUserError,
    );
    expect(() =>
      buildGitDiffArgs(
        diffInput({ rangeEndpoints: { from: "-x", to: "b" } } as Partial<ExtensionVcsDiffInput>),
      ),
    ).toThrow(HunkExtensionUserError);
  });
});

describe("buildGitDiffNumstatArgs", () => {
  test("adds --numstat -z with no color", () => {
    expect(buildGitDiffNumstatArgs(diffInput())).toEqual([
      ...DIFF_PREFIX_NORMALIZATION_ARGS,
      "diff",
      "--no-ext-diff",
      "--find-renames",
      "--no-color",
      "--numstat",
      "-z",
    ]);
  });
});

describe("buildGitStatusArgs", () => {
  test("no -c prefix, --no-optional-locks present", () => {
    expect(buildGitStatusArgs(diffInput())).toEqual([
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
  });

  test("pathspecs filter the status query", () => {
    const args = buildGitStatusArgs(diffInput({ pathspecs: ["dir/**"] }));
    expect(args.slice(-2)).toEqual(["--", "dir/**"]);
  });
});

describe("buildGitNoIndexDiffArgs", () => {
  test("plain path operand", () => {
    expect(buildGitNoIndexDiffArgs("new file.txt")).toEqual([
      ...DIFF_PREFIX_NORMALIZATION_ARGS,
      "diff",
      "--no-ext-diff",
      "--no-color",
      "--no-index",
      "/dev/null",
      "new file.txt",
    ]);
  });

  test("option-like path is ./-prefixed", () => {
    const args = buildGitNoIndexDiffArgs("-weird");
    expect(args[args.length - 1]).toBe("./-weird");
  });
});

describe("parseGitNumstat", () => {
  test("parses NUL-separated records", () => {
    // Concatenated so "\0" is never read as an octal escape ("\045" === "%").
    const files = parseGitNumstat("12\t3\ta.txt\0" + "45\t6\tb/c.txt\0");
    expect(files).toEqual([
      { path: "a.txt", additions: 12, deletions: 3 },
      { path: "b/c.txt", additions: 45, deletions: 6 },
    ]);
  });

  test("binary (-) and rename entries are dropped like the built-in", () => {
    // git numstat -z rename shape: "1\t1\t\0old.txt\0new.txt\0"
    const files = parseGitNumstat("-\t-\tbin.dat\0" + "1\t1\t\0old.txt\0new.txt\0");
    expect(files).toEqual([]);
  });
});

describe("parseUntrackedFilePaths", () => {
  test("collects only ?? entries", () => {
    const paths = parseUntrackedFilePaths(
      "?? untracked-gbk.txt\0M  gbk.txt\0?? nested/untracked-utf8.txt\0",
    );
    expect(paths).toEqual(["untracked-gbk.txt", "nested/untracked-utf8.txt"]);
  });
});

describe("parseSymmetricDiffRange", () => {
  test("splits A...B", () => {
    expect(parseSymmetricDiffRange("main...feature")).toEqual({
      left: "main",
      right: "feature",
    });
  });

  test("defaults empty sides to HEAD", () => {
    expect(parseSymmetricDiffRange("...feature")).toEqual({ left: "HEAD", right: "feature" });
    expect(parseSymmetricDiffRange("main...")).toEqual({ left: "main", right: "HEAD" });
  });

  test("non-symmetric ranges return null", () => {
    expect(parseSymmetricDiffRange("main..feature")).toBeNull();
    expect(parseSymmetricDiffRange("main")).toBeNull();
  });

  test("four-dot runs are rejected", () => {
    expect(parseSymmetricDiffRange("a....b")).toBeNull();
  });
});

describe("commandLabel", () => {
  test("labels match the built-in wording", () => {
    expect(commandLabel(diffInput())).toBe("hunk diff");
    expect(commandLabel(diffInput({ staged: true }))).toBe("hunk diff --staged");
    expect(commandLabel(diffInput({ range: "main" }))).toBe("hunk diff main");
    expect(
      commandLabel(diffInput({ rangeEndpoints: { from: "a", to: "b" } } as Partial<ExtensionVcsDiffInput>)),
    ).toBe("hunk diff a..b");
  });

  test("show and stash labels follow the built-in spelling", () => {
    expect(commandLabel(showInput())).toBe("hunk show");
    expect(commandLabel(showInput({ ref: "HEAD~1" }))).toBe("hunk show HEAD~1");
    expect(commandLabel(stashInput())).toBe("hunk stash show");
    expect(commandLabel(stashInput({ ref: "stash@{2}" }))).toBe("hunk stash show stash@{2}");
  });
});

describe("describeDiffRange", () => {
  test("endpoints join into A..B; plain range passes through", () => {
    expect(describeDiffRange(diffInput({ rangeEndpoints: { from: "a", to: "b" } } as Partial<ExtensionVcsDiffInput>))).toBe("a..b");
    expect(describeDiffRange(diffInput({ range: "main..feature" }))).toBe("main..feature");
    expect(describeDiffRange(diffInput())).toBeUndefined();
  });
});

describe("buildGitShowArgs", () => {
  test("no ref matches the built-in flag set", () => {
    expect(buildGitShowArgs(showInput())).toEqual([
      ...DIFF_PREFIX_NORMALIZATION_ARGS,
      "show",
      "--format=",
      "--no-ext-diff",
      "--find-renames",
      "--no-color",
    ]);
  });

  test("ref is validated then appended, pathspecs after --", () => {
    expect(buildGitShowArgs(showInput({ ref: "v1.2", pathspecs: ["src/**"] }))).toEqual([
      ...DIFF_PREFIX_NORMALIZATION_ARGS,
      "show",
      "--format=",
      "--no-ext-diff",
      "--find-renames",
      "--no-color",
      "v1.2",
      "--",
      "src/**",
    ]);
  });

  test("option-like ref is refused", () => {
    expect(() => buildGitShowArgs(showInput({ ref: "--output=x" }))).toThrow(HunkExtensionUserError);
  });

  test("colorMoved prepends the fixed palette and enables ANSI (exact order)", () => {
    expect(buildGitShowArgs(showInput({ ref: "abc" }), { mode: "zebra" })).toEqual([
      ...DIFF_PREFIX_NORMALIZATION_ARGS,
      ...GIT_MOVED_LINE_COLOR_CONFIG,
      "show",
      "--format=",
      "--no-ext-diff",
      "--find-renames",
      "--color=always",
      "--color-moved=zebra",
      "abc",
    ]);
  });

  test("whitespaceMode adds --color-moved-ws", () => {
    const args = buildGitShowArgs(showInput(), { mode: "zebra", whitespaceMode: "ignore-all-space" });
    expect(args.slice(-2)).toEqual(["--color-moved=zebra", "--color-moved-ws=ignore-all-space"]);
  });
});

describe("buildGitStashShowArgs", () => {
  test("no ref matches the built-in flag set", () => {
    expect(buildGitStashShowArgs(stashInput())).toEqual([
      ...DIFF_PREFIX_NORMALIZATION_ARGS,
      "stash",
      "show",
      "-p",
      "--no-ext-diff",
      "--find-renames",
      "--no-color",
    ]);
  });

  test("ref is appended; pathspecs are not supported", () => {
    expect(buildGitStashShowArgs(stashInput({ ref: "stash@{1}" }))).toEqual([
      ...DIFF_PREFIX_NORMALIZATION_ARGS,
      "stash",
      "show",
      "-p",
      "--no-ext-diff",
      "--find-renames",
      "--no-color",
      "stash@{1}",
    ]);
  });

  test("option-like ref is refused", () => {
    expect(() => buildGitStashShowArgs(stashInput({ ref: "-p2" }))).toThrow(HunkExtensionUserError);
  });

  test("colorMoved composition mirrors the diff command", () => {
    const args = buildGitStashShowArgs(stashInput(), { mode: "dimmed-zebra" });
    expect(args.slice(0, DIFF_PREFIX_NORMALIZATION_ARGS.length)).toEqual([...DIFF_PREFIX_NORMALIZATION_ARGS]);
    expect(args.slice(DIFF_PREFIX_NORMALIZATION_ARGS.length)).toEqual([
      ...GIT_MOVED_LINE_COLOR_CONFIG,
      "stash",
      "show",
      "-p",
      "--no-ext-diff",
      "--find-renames",
      "--color=always",
      "--color-moved=dimmed-zebra",
    ]);
  });
});

describe("buildGitDiffArgs with colorMoved", () => {
  test("plain review keeps --no-color", () => {
    expect(buildGitDiffArgs(diffInput())).toEqual([
      ...DIFF_PREFIX_NORMALIZATION_ARGS,
      "diff",
      "--no-ext-diff",
      "--find-renames",
      "--no-color",
    ]);
  });

  test("colorMoved replaces --no-color with the ANSI set", () => {
    expect(buildGitDiffArgs(diffInput({ staged: true }), [], { mode: "zebra" })).toEqual([
      ...DIFF_PREFIX_NORMALIZATION_ARGS,
      ...GIT_MOVED_LINE_COLOR_CONFIG,
      "diff",
      "--no-ext-diff",
      "--find-renames",
      "--color=always",
      "--color-moved=zebra",
      "--staged",
    ]);
  });
});

describe("normalizeGitColorMovedMode", () => {
  test("boolean true values become zebra", () => {
    for (const value of ["true", "yes", "on", "1", "always", "TRUE", "On"]) {
      expect(normalizeGitColorMovedMode(value)).toBe("zebra");
    }
  });

  test("boolean false values suppress move detection", () => {
    for (const value of ["false", "no", "off", "0", "never", "NO"]) {
      expect(normalizeGitColorMovedMode(value)).toBeNull();
    }
  });

  test("explicit modes pass through verbatim", () => {
    expect(normalizeGitColorMovedMode("dimmed-zebra")).toBe("dimmed-zebra");
    expect(normalizeGitColorMovedMode("plain")).toBe("plain");
  });

  test("unset is undefined", () => {
    expect(normalizeGitColorMovedMode(undefined)).toBeUndefined();
    expect(normalizeGitColorMovedMode("")).toBeUndefined();
  });
});

describe("statSignature", () => {
  test("existing files yield path:size:mtimeMs:ino", () => {
    const file = join(tmpdir(), `hunk-enc-stat-${Date.now()}.txt`);
    writeFileSync(file, "hello\n");
    try {
      const stat = statSync(file);
      expect(statSignature(file)).toBe(
        `${file}:${stat.size}:${stat.mtimeMs}:${stat.ino}`,
      );
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("missing paths yield the :missing marker (built-in shape)", () => {
    expect(statSignature(join(tmpdir(), "hunk-enc-no-such-file-xyz"))).toBe(
      `${join(tmpdir(), "hunk-enc-no-such-file-xyz")}:missing`,
    );
  });
});

describe("translateGitExitFailure — per-kind messages", () => {
  const UNKNOWN = "fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.";

  test("show ref failures name the ref", () => {
    const error = translateGitExitFailure(showInput({ ref: "nope" }), UNKNOWN);
    expect(error.message).toBe("`hunk show nope` could not resolve Git ref `nope`.");
  });

  test("show without ref names HEAD", () => {
    const error = translateGitExitFailure(showInput(), UNKNOWN);
    expect(error.message).toBe("`hunk show` could not resolve Git ref `HEAD`.");
  });

  test("stash failures map to the missing-stash wording", () => {
    const withRef = translateGitExitFailure(stashInput({ ref: "stash@{5}" }), UNKNOWN);
    expect(withRef.message).toBe("`hunk stash show stash@{5}` could not resolve stash entry `stash@{5}`.");

    const withoutRef = translateGitExitFailure(stashInput(), "No stash entries found.");
    expect(withoutRef.message).toBe("`hunk stash show` could not find a stash entry to show.");
  });

  test("diff range failures quote the range and offer the path split", () => {
    const input = diffInput({ rangeEndpoints: { from: "a", to: "b" } } as Partial<ExtensionVcsDiffInput>);
    const error = translateGitExitFailure(input, UNKNOWN);
    expect(error.message).toBe("`hunk diff a..b` could not resolve Git revision or range `a..b`.");
    expect(error.suggestions).toContain("To limit the review to a path, separate it: `hunk diff a -- b`.");
  });

  test("missing-repo suggestions differ per kind", () => {
    const show = translateGitExitFailure(showInput(), "fatal: not a git repository");
    expect(show.suggestions).toEqual(["Run the command from a Git checkout."]);

    const diff = translateGitExitFailure(diffInput(), "fatal: not a git repository");
    expect(diff.suggestions?.[0]).toContain("compare files directly instead");
  });
});
