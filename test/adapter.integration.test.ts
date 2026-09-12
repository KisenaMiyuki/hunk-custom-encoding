/**
 * Adapter-level integration tests (plan §9.2).
 *
 * Real fixture git repos (test/fixtures.ts); the adapter's load() /
 * readFileSource() are called in-process with a fake ctx, exactly as the
 * host would drive them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HunkExtensionUserError, type ExtensionVcsDiffInput } from "hunkdiff/extension";
import { parseExtensionSettings } from "../src/config";
import { createEncodingGitAdapter, detectGitRepo } from "../src/adapter";
import { buildGitDiffArgs } from "../src/git";
import { buildMixedEncodingRepo, buildUtf8OnlyRepo, hx, type FixtureRepo } from "./fixtures";

const TIMEOUT = 60_000;

let mixed: FixtureRepo;
let utf8Repo: FixtureRepo;
let defaultAdapter: ReturnType<typeof createEncodingGitAdapter>;
let configuredAdapter: ReturnType<typeof createEncodingGitAdapter>;

const diffInput = (overrides: Partial<ExtensionVcsDiffInput> = {}): ExtensionVcsDiffInput => ({
  kind: "vcs",
  staged: false,
  options: {},
  ...overrides,
});

const load = (
  adapter: typeof defaultAdapter,
  input: ExtensionVcsDiffInput,
  cwd: string = mixed.root,
) => adapter.operations!["working-tree-diff"]!.load(input, { cwd });

const repoNameOf = (root: string) => root.replace(/\\/g, "/").split("/").pop()!;

/** Pull one patch entry's text, failing loudly when it is missing. */
function patchTextOf(
  files: NonNullable<Awaited<ReturnType<typeof load>>["extraFiles"]>,
  path: string,
): string {
  const entry = files.find((file) => file.kind === "patch" && file.path === path);
  if (!entry || entry.kind !== "patch") {
    throw new Error(`missing patch extraFile for ${path}`);
  }
  return entry.patchText;
}

beforeAll(async () => {
  mixed = buildMixedEncodingRepo();
  utf8Repo = buildUtf8OnlyRepo();
  defaultAdapter = createEncodingGitAdapter(parseExtensionSettings(undefined));
  configuredAdapter = createEncodingGitAdapter(
    parseExtensionSettings({
      overrides: {
        "sjis.txt": "shift_jis",
        "big5.txt": "big5",
        "untracked-sjis.txt": "shift_jis",
      },
    }),
  );
}, TIMEOUT);

afterAll(() => {
  mixed?.cleanup();
  utf8Repo?.cleanup();
});

/* Expected legacy decodes, computed from the fixture bytes themselves. */
const expectGbk = (bytes: Buffer) => new TextDecoder("gbk").decode(bytes);

describe("detection", () => {
  test("recognizes the fixture repo with its own id", () => {
    const detection = detectGitRepo(mixed.root);
    expect(detection).toEqual({
      id: "hunk-custom-encoding",
      repoRoot: mixed.root.replace(/\\/g, "/"),
    });
  });
});

describe("working-tree-diff — plain (index ↔ worktree)", () => {
  let result: Awaited<ReturnType<typeof load>>;

  beforeAll(async () => {
    result = await load(defaultAdapter, diffInput());
  }, TIMEOUT);

  test("labels and title follow the built-in shape", () => {
    expect(result.repoRoot).toBe(mixed.root.replace(/\\/g, "/"));
    expect(result.sourceLabel).toBe(result.repoRoot);
    expect(result.title).toBe(`${repoNameOf(mixed.root)} working tree`);
  });

  test("GBK content decodes with no replacement characters", () => {
    expect(result.patchText).toContain("+新内容");
    expect(result.patchText).toContain("-旧内容");
    expect(result.patchText).not.toContain("\uFFFD");
  });

  test("UTF-8 segments pass through untouched", () => {
    expect(result.patchText).toContain("第二版 中文修改");
  });

  test("binary segment passes through", () => {
    expect(result.patchText).toContain("Binary files a/bin.dat and b/bin.dat differ");
  });

  test("CJK ambiguity: default candidates decode SJIS bytes as GBK", () => {
    expect(result.patchText).not.toContain("こんにちは"); // documented limitation
  });

  test("sourceCacheKey follows the built-in shape plus encoding fingerprints", () => {
    // Plain diff: old=index, new=worktree.
    expect(result.sourceCacheKey).toMatch(
      /^git-source-v1:index:[0-9a-f]{64}:[0-9a-f]{12}:worktree:[0-9a-f]{12}$/,
    );
  });

  test("tracked large file is skipped with stats", () => {
    const skipped = result.extraFiles?.find((file) => file.path === "big-tracked.txt");
    expect(skipped).toMatchObject({ kind: "skipped", reason: "too-large" });
    expect(result.patchText).not.toContain("big-tracked.txt");
  });

  test("untracked files ship as self-produced transcode patches (ADR-0002)", () => {
    expect(patchTextOf(result.extraFiles!, "untracked-gbk.txt")).toContain("新内容");
    expect(patchTextOf(result.extraFiles!, "untracked-utf8.txt")).toContain("untracked utf8");
    const skippedUntracked = result.extraFiles
      ?.filter((file) => file.kind === "skipped" && file.isUntracked)
      .map((file) => file.path)
      .sort();
    expect(skippedUntracked).toEqual([
      "untracked-big.txt", // size gate
      "untracked-many.txt", // line gate
    ]);
    expect(result.patchText).not.toContain("untracked-");
  });

  test("no replacement characters anywhere in the result", () => {
    const allText = [
      result.patchText,
      ...(result.extraFiles ?? []).map((file) => (file.kind === "patch" ? file.patchText : "")),
    ].join("\n");
    expect(allText).not.toContain("\uFFFD");
  });
});

describe("working-tree-diff — configured overrides", () => {
  let configured: Awaited<ReturnType<typeof load>>;
  let plain: Awaited<ReturnType<typeof load>>;

  beforeAll(async () => {
    configured = await load(configuredAdapter, diffInput());
    plain = await load(defaultAdapter, diffInput());
  }, TIMEOUT);

  test("overrides pin SJIS and Big5 segments through the pipeline", () => {
    expect(configured.patchText).toContain("こんにちは");
    expect(configured.patchText).toContain("繁體中文");
    // Candidate-list behavior is unchanged for unlisted files.
    expect(configured.patchText).toContain("新内容");
  });

  test("overrides reach the untracked self-produced diffs too", () => {
    expect(patchTextOf(configured.extraFiles!, "untracked-sjis.txt")).toContain("こんにちは");
  });

  test("sourceCacheKey changes when the encoding config changes", () => {
    expect(configured.sourceCacheKey).not.toBe(plain.sourceCacheKey);
  });
});

describe("working-tree-diff — staged (HEAD ↔ index)", () => {
  let result: Awaited<ReturnType<typeof load>>;

  beforeAll(async () => {
    result = await load(defaultAdapter, diffInput({ staged: true }));
  }, TIMEOUT);

  test("title says staged changes", () => {
    expect(result.title).toBe(`${repoNameOf(mixed.root)} staged changes`);
  });

  test("staged content decodes; rename and mode-only segments survive", () => {
    expect(result.patchText).toContain("staged v2");
    expect(result.patchText).toContain("rename from old-gbk.txt");
    expect(result.patchText).toContain("rename to renamed-gbk.txt");
    expect(result.patchText).toContain("old mode 100644");
    expect(result.patchText).toContain("new mode 100755");
    expect(result.patchText).not.toContain("\uFFFD");
  });

  test("staged review excludes untracked files", () => {
    expect(result.extraFiles?.some((file) => file.isUntracked)).toBe(false);
    expect(result.extraFiles?.some((file) => file.path.startsWith("untracked-"))).toBe(false);
  });

  test("sourceCacheKey pins HEAD by sha and hashes the index", () => {
    expect(result.sourceCacheKey).toContain(`ref:${mixed.headSha}`);
    expect(result.sourceCacheKey).toMatch(
      /^git-source-v1:ref:[0-9a-f]{40}:[0-9a-f]{12}:index:[0-9a-f]{64}:[0-9a-f]{12}$/,
    );
  });
});

describe("working-tree-diff — single revision (ref ↔ worktree)", () => {
  let result: Awaited<ReturnType<typeof load>>;

  beforeAll(async () => {
    result = await load(defaultAdapter, diffInput({ range: "HEAD" }));
  }, TIMEOUT);

  test("title names the revision; untracked files stay included", () => {
    expect(result.title).toBe(`${repoNameOf(mixed.root)} HEAD`);
    expect(result.extraFiles?.some((file) => file.path === "untracked-gbk.txt")).toBe(true);
  });

  test("sourceCacheKey resolves the revision to its sha", () => {
    expect(result.sourceCacheKey).toContain(`ref:${mixed.headSha}`);
  });
});

describe("working-tree-diff — symmetric range string (merge-base)", () => {
  let result: Awaited<ReturnType<typeof load>>;

  beforeAll(async () => {
    result = await load(defaultAdapter, diffInput({ range: "HEAD...side" }));
  }, TIMEOUT);

  test("old side resolves to the merge base (fork point)", () => {
    // side forked from headSha, so merge-base(HEAD, side) === headSha.
    expect(result.sourceCacheKey).toContain(`ref:${mixed.headSha}`);
    expect(result.sourceCacheKey).toContain(`ref:${mixed.sideSha}`);
  });

  test("commit-to-commit reviews exclude untracked files", () => {
    expect(result.extraFiles?.some((file) => file.isUntracked)).toBe(false);
  });

  test("readFileSource reads blobs from the exact resolved revisions", async () => {
    const reader = result.readFileSource!;
    const newSide = await reader({
      path: "side.txt",
      changeType: "change",
      isUntracked: false,
      side: "new",
    });
    expect(newSide).toBe("side content\n");
    // side.txt does not exist at the merge base — the old side is absent.
    const oldSide = await reader({
      path: "side.txt",
      changeType: "change",
      isUntracked: false,
      side: "old",
    });
    expect(oldSide).toBeNull();
  });
});

describe("working-tree-diff — rangeEndpoints (from..to)", () => {
  let result: Awaited<ReturnType<typeof load>>;

  beforeAll(async () => {
    result = await load(
      defaultAdapter,
      diffInput({ rangeEndpoints: { from: "HEAD", to: "side" } }),
    );
  }, TIMEOUT);

  test("title shortens the endpoint range", () => {
    expect(result.title).toBe(`${repoNameOf(mixed.root)} HEAD..side`);
  });

  test("endpoints resolve both sides to commit shas", () => {
    expect(result.sourceCacheKey).toContain(`ref:${mixed.headSha}`);
    expect(result.sourceCacheKey).toContain(`ref:${mixed.sideSha}`);
  });
});

describe("readFileSource — per-side independent probing (Q9)", () => {
  let plain: Awaited<ReturnType<typeof load>>;
  let staged: Awaited<ReturnType<typeof load>>;

  beforeAll(async () => {
    plain = await load(defaultAdapter, diffInput());
    staged = await load(defaultAdapter, diffInput({ staged: true }));
  }, TIMEOUT);

  test("a file rewritten GBK → UTF-8 decodes correctly on both sides", async () => {
    const reader = plain.readFileSource!;

    // Old side = index blob (still the committed GBK bytes).
    const oldSide = await reader({
      path: "switch.txt",
      changeType: "change",
      isUntracked: false,
      side: "old",
    });
    expect(oldSide).toBe(expectGbk(hx("bec9d6d0cec40a")));

    // New side = worktree (UTF-8 rewrite).
    const newSide = await reader({
      path: "switch.txt",
      changeType: "change",
      isUntracked: false,
      side: "new",
    });
    expect(newSide).toBe("新中文 utf8\n");
  });

  test("renamed file's old side reads via previousPath", async () => {
    const reader = staged.readFileSource!;
    const oldSide = await reader({
      path: "renamed-gbk.txt",
      previousPath: "old-gbk.txt",
      changeType: "rename-pure",
      isUntracked: false,
      side: "old",
    });
    expect(oldSide).toBe(expectGbk(hx("bec9c4dac8dd0a")));
  });

  test("added and deleted sides are null; oversized worktree file reports the limit", async () => {
    const reader = plain.readFileSource!;

    expect(
      await reader({ path: "untracked-gbk.txt", changeType: "new", isUntracked: true, side: "old" }),
    ).toBeNull();
    expect(
      await reader({ path: "untracked-gbk.txt", changeType: "new", isUntracked: true, side: "new" }),
    ).toContain("新内容");

    const tooLarge = await reader({
      path: "big-tracked.txt",
      changeType: "change",
      isUntracked: false,
      side: "new",
    });
    expect(tooLarge).toEqual({ kind: "too-large", maxBytes: 1_000_000 });
  });

  test("binary sources decline instead of transcoding", async () => {
    const reader = plain.readFileSource!;
    const side = await reader({
      path: "bin.dat",
      changeType: "change",
      isUntracked: false,
      side: "new",
    });
    expect(side).toBeNull();
  });
});

describe("pathspecs and option gating", () => {
  test("pathspecs filter both the patch and untracked discovery", async () => {
    const result = await load(
      defaultAdapter,
      diffInput({ pathspecs: ["gbk.txt", "untracked-gbk.txt"] }),
    );
    expect(result.patchText).toContain("新内容");
    expect(result.patchText).not.toContain("第二版");
    expect(result.extraFiles?.some((file) => file.path === "untracked-gbk.txt")).toBe(true);
    expect(result.extraFiles?.some((file) => file.path === "untracked-utf8.txt")).toBe(false);
  }, TIMEOUT);

  test("excludeUntracked drops the self-produced diffs", async () => {
    const result = await load(
      defaultAdapter,
      diffInput({ options: { excludeUntracked: true } }),
    );
    expect(result.extraFiles?.some((file) => file.isUntracked)).toBe(false);
  }, TIMEOUT);

  test("unresolvable ranges surface a user error", async () => {
    let error: unknown;
    try {
      await load(defaultAdapter, diffInput({ range: "no-such-ref-xyz" }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HunkExtensionUserError);
  }, TIMEOUT);
});

describe("UTF-8 baseline — zero regression", () => {
  test("adapter patchText is byte-identical to plain git diff output", async () => {
    const input = diffInput();
    const args = buildGitDiffArgs(input);
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: utf8Repo.root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const gitText = Buffer.from(proc.stdout ?? []).toString("utf8");

    const result = await load(defaultAdapter, input, utf8Repo.root);
    expect(result.patchText).toBe(gitText);
    expect(result.patchText).toContain("hello changed");
    expect(result.extraFiles?.some((file) => file.path === "new-utf8.txt")).toBe(true);
  }, TIMEOUT);
});
