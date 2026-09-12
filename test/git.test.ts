/**
 * Unit tests for src/git.ts + src/endpoints.ts pure helpers (plan §9.1).
 */
import { describe, expect, test } from "bun:test";
import { HunkExtensionUserError, type ExtensionVcsDiffInput } from "hunkdiff/extension";
import {
  DIFF_PREFIX_NORMALIZATION_ARGS,
  buildGitDiffArgs,
  buildGitDiffNumstatArgs,
  buildGitNoIndexDiffArgs,
  buildGitStatusArgs,
  commandLabel,
  parseGitNumstat,
  parseUntrackedFilePaths,
} from "../src/git";
import { parseSymmetricDiffRange } from "../src/endpoints";

const diffInput = (overrides: Partial<ExtensionVcsDiffInput> = {}): ExtensionVcsDiffInput => ({
  kind: "vcs",
  staged: false,
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
});
