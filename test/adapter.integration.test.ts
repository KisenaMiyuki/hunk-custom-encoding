/**
 * Adapter-level integration tests (plan §9.2).
 *
 * Real fixture git repos (test/fixtures.ts); the adapter's load() /
 * readFileSource() are called in-process with a fake ctx, exactly as the
 * host would drive them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  HunkExtensionUserError,
  type ExtensionVcsDiffInput,
  type ExtensionVcsShowInput,
  type ExtensionVcsStashShowInput,
} from "hunkdiff/extension";
import { parseExtensionSettings } from "../src/config";
import { createEncodingGitAdapter, detectGitRepo, statSignature } from "../src/adapter";
import { buildGitDiffArgs, buildGitShowArgs, buildGitStashShowArgs, runGitBytes } from "../src/git";
import { transcodePatch } from "../src/patch";
import {
  buildMixedEncodingRepo,
  buildShowRepo,
  buildUtf8OnlyRepo,
  hx,
  type FixtureRepo,
  type ShowFixtureRepo,
} from "./fixtures";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TIMEOUT = 60_000;

let mixed: FixtureRepo;
let utf8Repo: FixtureRepo;
let showRepo: ShowFixtureRepo;
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
  showRepo?.cleanup();
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

/* -------------------------------------------------------------------------- */
/* M3: revision-show / stash-show / watchSignature / colorMoved                */
/* -------------------------------------------------------------------------- */

const showRepoName = () => showRepo.root.replace(/\\/g, "/").split("/").pop()!;

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

const loadShow = (input: ExtensionVcsShowInput, cwd = showRepo.root) =>
  defaultAdapter.operations!["revision-show"]!.load(input, { cwd });

const loadStash = (input: ExtensionVcsStashShowInput, cwd = showRepo.root) =>
  defaultAdapter.operations!["stash-show"]!.load(input, { cwd });

/** The default-settings transcode of one git invocation (watch-signature oracle). */
const transcodedGitText = async (
  args: string[],
  cwd: string,
  settings = defaultSettings,
): Promise<string> => {
  const result = await runGitBytes({ args, cwd, label: "test oracle" });
  return transcodePatch(result.stdout, settings);
};

const defaultSettings = parseExtensionSettings(undefined);

describe("revision-show (M3)", () => {
  beforeAll(() => {
    showRepo = buildShowRepo();
  }, TIMEOUT);
  // No describe-level cleanup: showRepo is shared by the stash/watch/colorMoved
  // describes below; the module-level afterAll owns its teardown.

  test("default ref (HEAD): title, transcoded GBK patch, no U+FFFD", async () => {
    const result = await loadShow(showInput());
    expect(result.title).toBe(`${showRepoName()} show HEAD`);
    expect(result.repoRoot).toBe(showRepo.root.replace(/\\/g, "/"));
    expect(result.patchText).toContain("-旧内容");
    expect(result.patchText).toContain("+新内容");
    expect(result.patchText).not.toContain("\uFFFD");
  }, TIMEOUT);

  test("explicit ref is quoted in the title but resolved for the patch", async () => {
    const result = await loadShow(showInput({ ref: "HEAD" }));
    expect(result.title).toBe(`${showRepoName()} show HEAD`);
    expect(result.patchText).toContain("+新内容");
  }, TIMEOUT);

  test("sourceCacheKey pins the resolved commit on both sides", async () => {
    const result = await loadShow(showInput());
    expect(result.sourceCacheKey).toMatch(
      new RegExp(`^git-source-v1:ref:${showRepo.headSha}\\^:[0-9a-f]{12}:ref:${showRepo.headSha}:[0-9a-f]{12}$`),
    );
  }, TIMEOUT);

  test("readFileSource reads both sides from the resolved revisions", async () => {
    const result = await loadShow(showInput());
    const old = await result.readFileSource!({
      path: "gbk.txt",
      changeType: "change",
      isUntracked: false,
      side: "old",
    });
    const added = await result.readFileSource!({
      path: "added-gbk.txt",
      changeType: "new",
      isUntracked: false,
      side: "old",
    });
    expect(old).toContain("旧内容");
    expect(added).toBeNull(); // added file has no old side
  }, TIMEOUT);

  test("root commit's old side degrades to null", async () => {
    const result = await loadShow(showInput({ ref: showRepo.rootSha }));
    const old = await result.readFileSource!({
      path: "gbk.txt",
      changeType: "change",
      isUntracked: false,
      side: "old",
    });
    expect(old).toBeNull();
    const added = await result.readFileSource!({
      path: "gbk.txt",
      changeType: "change",
      isUntracked: false,
      side: "new",
    });
    expect(added).toContain("旧内容"); // the commit's own blob still reads
  }, TIMEOUT);

  test("pathspecs limit the patch", async () => {
    const result = await loadShow(showInput({ ref: showRepo.headSha, pathspecs: ["gbk.txt"] }));
    expect(result.patchText).toContain("gbk.txt");
    expect(result.patchText).not.toContain("added-gbk.txt");
  }, TIMEOUT);

  test("bad ref surfaces the built-in ref error", async () => {
    let message = "";
    try {
      await loadShow(showInput({ ref: "no-such-ref-xyz" }));
    } catch (caught) {
      message = (caught as Error).message;
    }
    expect(message).toBe("`hunk show no-such-ref-xyz` could not resolve Git ref `no-such-ref-xyz`.");
  }, TIMEOUT);

  test("watch signature equals the transcoded show text", async () => {
    const input = showInput({ ref: showRepo.headSha });
    const signature = await defaultAdapter.operations!["revision-show"]!.watchSignature!(input, {
      cwd: showRepo.root,
    });
    expect(signature).toBe(
      await transcodedGitText(buildGitShowArgs(input), showRepo.root),
    );
  }, TIMEOUT);
});

describe("stash-show (M3)", () => {
  test("default stash@{0}: title and transcoded patch", async () => {
    const result = await loadStash(stashInput());
    expect(result.title).toBe(`${showRepoName()} stash`);
    expect(result.patchText).toContain("-新内容");
    expect(result.patchText).toContain("+旧中文");
    expect(result.patchText).not.toContain("\uFFFD");
  }, TIMEOUT);

  test("explicit ref is quoted in the title", async () => {
    const result = await loadStash(stashInput({ ref: "stash@{0}" }));
    expect(result.title).toBe(`${showRepoName()} stash stash@{0}`);
  }, TIMEOUT);

  test("source reader reads from the stash commit and its parent", async () => {
    const result = await loadStash(stashInput());
    const before = await result.readFileSource!({
      path: "gbk.txt",
      changeType: "change",
      isUntracked: false,
      side: "old",
    });
    const stashed = await result.readFileSource!({
      path: "gbk.txt",
      changeType: "change",
      isUntracked: false,
      side: "new",
    });
    expect(before).toContain("新内容");
    expect(stashed).toContain("旧中文");
  }, TIMEOUT);

  test("no stash entries surface the built-in wording", async () => {
    let message = "";
    try {
      await loadStash(stashInput(), utf8Repo.root);
    } catch (caught) {
      message = (caught as Error).message;
    }
    expect(message).toBe("`hunk stash show` could not find a stash entry to show.");
  }, TIMEOUT);

  test("watch signature equals the transcoded stash text", async () => {
    const input = stashInput();
    const signature = await defaultAdapter.operations!["stash-show"]!.watchSignature!(input, {
      cwd: showRepo.root,
    });
    expect(signature).toBe(await transcodedGitText(buildGitStashShowArgs(input), showRepo.root));
  }, TIMEOUT);
});

describe("watchSignature — working-tree (M3)", () => {
  const untrackedPath = () => join(showRepo.root, "watch-untracked.txt");

  beforeAll(() => {
    showRepo = showRepo ?? buildShowRepo();
    // A clean-worktree scenario: one unstaged GBK rewrite + one untracked file.
    writeFileSync(join(showRepo.root, "gbk.txt"), hx("bec9d6d0cec40a")); // 旧中文
    writeFileSync(untrackedPath(), Buffer.from("watch me\n", "utf8"));
  }, TIMEOUT);
  afterAll(() => {
    rmSync(untrackedPath(), { force: true });
    // restore the committed state
    Bun.spawnSync(["git", "checkout", "-q", "--", "gbk.txt"], { cwd: showRepo.root });
  });

  test("signature is [transcoded patch, untracked fragments] joined with ---", async () => {
    const input = diffInput();
    const signature = await defaultAdapter.operations!["working-tree-diff"]!.watchSignature!(input, {
      cwd: showRepo.root,
    });

    const expectedPatch = await transcodedGitText(buildGitDiffArgs(input), showRepo.root);
    const expected = [expectedPatch, `untracked:${statSignature(untrackedPath())}`].join("\n---\n");
    expect(signature).toBe(expected);

    // Pin the fragment format: absolute path + size + mtimeMs + ino.
    const fragment = signature.split("\n---\n")[1]!;
    expect(fragment).toMatch(/^untracked:.+:\d+:\d+(\.\d+)?:\d+$/);
  }, TIMEOUT);

  test("untracked files deleted before status produce no fragment", async () => {
    // `:missing` fragments only arise when the path vanishes between the
    // status listing and its stat; deleting it up front removes the file
    // from the listing entirely (built-in semantics).
    rmSync(untrackedPath(), { force: true });
    const signature = await defaultAdapter.operations!["working-tree-diff"]!.watchSignature!(
      diffInput(),
      { cwd: showRepo.root },
    );
    const parts = signature.split("\n---\n");
    expect(parts).toHaveLength(1); // only the tracked patch
    expect(signature).not.toContain("untracked:");
  }, TIMEOUT);

  test("encoding config changes trip the signature (Q5)", async () => {
    writeFileSync(untrackedPath(), Buffer.from("watch me\n", "utf8"));
    const input = diffInput();
    const base = await defaultAdapter.operations!["working-tree-diff"]!.watchSignature!(input, {
      cwd: showRepo.root,
    });
    const big5Adapter = createEncodingGitAdapter(
      parseExtensionSettings({ encodings: ["big5"], fallback: "gbk" }),
    );
    const reconfigured = await big5Adapter.operations!["working-tree-diff"]!.watchSignature!(input, {
      cwd: showRepo.root,
    });
    expect(reconfigured).not.toBe(base);
  }, TIMEOUT);

  test("watch signature stays ANSI-free even with diff.colorMoved configured", async () => {
    Bun.spawnSync(["git", "config", "diff.colorMoved", "zebra"], { cwd: showRepo.root });
    const signature = await defaultAdapter.operations!["working-tree-diff"]!.watchSignature!(
      diffInput(),
      { cwd: showRepo.root },
    );
    expect(signature).not.toContain("\u001b[");
    Bun.spawnSync(["git", "config", "--unset", "diff.colorMoved"], { cwd: showRepo.root });
  }, TIMEOUT);
});

describe("colorMoved (M3)", () => {
  const setConfig = (key: string, value?: string) => {
    Bun.spawnSync(
      value === undefined
        ? ["git", "config", "--unset", key]
        : ["git", "config", key, value],
      { cwd: showRepo.root },
    );
  };

  afterAll(() => {
    setConfig("diff.colorMoved");
    setConfig("diff.colorMovedWS");
  });

  test("config diff.colorMoved=zebra colors the show patch — with GBK intact", async () => {
    setConfig("diff.colorMoved", "zebra");
    const result = await loadShow(showInput());
    expect(result.patchText).toContain("\u001b[");
    // Regression: painted content lines must still transcode (the segment
    // matcher has to skip the ANSI paint on structural lines).
    expect(result.patchText).toContain("新内容");
    expect(result.patchText).not.toContain("\uFFFD");
  }, TIMEOUT);

  test("config false wins over the review's --color-moved flag", async () => {
    setConfig("diff.colorMoved", "false");
    const result = await loadShow(showInput({ options: { colorMoved: true } }));
    expect(result.patchText).not.toContain("\u001b[");
  }, TIMEOUT);

  test("review's --color-moved maps to zebra when config is unset", async () => {
    setConfig("diff.colorMoved");
    const result = await loadShow(showInput({ options: { colorMoved: true } }));
    expect(result.patchText).toContain("\u001b[");
  }, TIMEOUT);

  test("without either source there is no ANSI", async () => {
    setConfig("diff.colorMoved");
    const result = await loadShow(showInput());
    expect(result.patchText).not.toContain("\u001b[");
  }, TIMEOUT);

  test("explicit config mode and whitespace setting pass through", async () => {
    setConfig("diff.colorMoved", "dimmed-zebra");
    setConfig("diff.colorMovedWS", "ignore-all-space");
    const result = await loadShow(showInput());
    expect(result.patchText).toContain("\u001b[");
    setConfig("diff.colorMovedWS");
  }, TIMEOUT);
});
