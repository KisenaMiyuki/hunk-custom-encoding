/**
 * The custom-encoding VCS adapter (plan §6, ADR-0001/0002/0004).
 *
 * A byte-exact replica of the built-in Git adapter's `working-tree-diff`
 * (verified against packages/hunk-git/src, 2026-09) with two deliberate
 * differences:
 *
 *   1. The main patch and every untracked patch run git in byte mode and
 *      pass the raw bytes through the M1 transcode pipeline, so non-UTF-8
 *      content survives (ADR-0001).
 *   2. Untracked files ship as self-produced `git diff --no-index` patches
 *      via `extraFiles` instead of `untrackedPaths` — the host synthesizes
 *      added-file diffs from its own UTF-8 reads, which would re-introduce
 *      mojibake (ADR-0002).
 *
 * `revision-show` / `stash-show` / `watchSignature` / `colorMoved` are M3;
 * `history` stays unimplemented (Q6 — `hunk log` reports "not supported").
 */

import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  HUNK_VCS_DETECTION_BASELINE_PRIORITY,
  type ExtensionVcsAdapter,
  type ExtensionVcsDiffInput,
  type ExtensionVcsExtraFile,
  type ExtensionVcsFileSourceReader,
  type ExtensionVcsFileSourceResult,
  type ExtensionVcsLoadContext,
  type ExtensionVcsPatchResult,
} from "hunkdiff/extension";
import {
  LARGE_DIFF_FILE_MAX_BYTES,
  LARGE_DIFF_FILE_MAX_LINES,
  SOURCE_TEXT_MAX_BYTES,
  buildGitDiffArgs,
  buildGitDiffNumstatArgs,
  buildGitNoIndexDiffArgs,
  buildGitStatusArgs,
  commandLabel,
  parseGitNumstat,
  parseUntrackedFilePaths,
  runGitBytes,
  runGitText,
} from "./git";
import { resolveGitDiffEndpoints, type GitDiffEndpoint, type GitDiffEndpoints } from "./endpoints";
import { transcodePatch } from "./patch";
import { detectEncoding, isLikelyBinary, transcode } from "./transcode";
import type { ExtensionSettings } from "./config";

/** Shorten one complete object id while preserving named revision spellings. */
const FULL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const GIT_RANGE = /^(.*?)(\.\.\.?)(.*)$/;

function shortenGitObjectId(revision: string): string {
  return FULL_GIT_OBJECT_ID.test(revision) ? revision.slice(0, 7) : revision;
}

/** Display range for the review title, mirroring the built-in shortening. */
function describeGitDiffTitleRange(input: ExtensionVcsDiffInput): string | undefined {
  if (input.rangeEndpoints) {
    return `${shortenGitObjectId(input.rangeEndpoints.from)}..${shortenGitObjectId(input.rangeEndpoints.to)}`;
  }
  const range = input.range;
  if (range === undefined) return undefined;
  const parsed = GIT_RANGE.exec(range);
  return parsed
    ? `${shortenGitObjectId(parsed[1]!)}${parsed[2]}${shortenGitObjectId(parsed[3]!)}`
    : shortenGitObjectId(range);
}

/** Normalize separators so detect() and rev-parse agree on Windows. */
function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Walk upward to find a Git worktree marker without spawning Git (built-in replica). */
export function detectGitRepo(cwd: string): { id: string; repoRoot: string } | null {
  let current = resolve(cwd);
  for (;;) {
    if (fs.existsSync(join(current, ".git"))) {
      return { id: "hunk-custom-encoding", repoRoot: normalizeRepoPath(current) };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function resolveGitRepoRoot(
  input: ExtensionVcsDiffInput,
  options: { cwd: string; signal?: AbortSignal },
): Promise<string> {
  const text = await runGitText({
    args: ["rev-parse", "--show-toplevel"],
    cwd: options.cwd,
    signal: options.signal,
    label: commandLabel(input),
  });
  return normalizeRepoPath(text.trim());
}

/* -------------------------------------------------------------------------- */
/* Untracked files (ADR-0002)                                                  */
/* -------------------------------------------------------------------------- */

/** Built-in replica: decline directories and symlinked directories. */
function isReviewableUntrackedPath(repoRoot: string, filePath: string): boolean {
  const absolutePath = join(repoRoot, filePath);
  let pathInfo: fs.Stats;
  try {
    pathInfo = fs.lstatSync(absolutePath);
  } catch {
    // If the path disappeared after `git status`, let downstream surface it.
    return true;
  }
  if (pathInfo.isDirectory()) return false;
  if (!pathInfo.isSymbolicLink()) return true;
  try {
    return !fs.statSync(absolutePath).isDirectory();
  } catch {
    return true; // broken symlinks still diff as reviewable path entries
  }
}

function countLines(bytes: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) count++;
  }
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) count++;
  return count;
}

/**
 * Build one extraFiles entry for an untracked path: a skipped placeholder
 * past the large-file gates, otherwise a self-produced transcode diff.
 */
async function buildUntrackedExtraFile(
  repoRoot: string,
  filePath: string,
  settings: ExtensionSettings,
  signal?: AbortSignal,
): Promise<ExtensionVcsExtraFile | null> {
  const absolutePath = join(repoRoot, filePath);
  let size: number;
  try {
    size = fs.statSync(absolutePath).size;
  } catch {
    return null; // disappeared between status and read
  }

  if (size > LARGE_DIFF_FILE_MAX_BYTES) {
    return { kind: "skipped", path: filePath, reason: "too-large", isUntracked: true };
  }

  const bytes = fs.readFileSync(absolutePath);
  const lines = countLines(bytes);
  if (lines > LARGE_DIFF_FILE_MAX_LINES) {
    return {
      kind: "skipped",
      path: filePath,
      reason: "too-large",
      changeType: "new",
      stats: { additions: lines, deletions: 0 },
      isUntracked: true,
    };
  }

  const result = await runGitBytes({
    args: buildGitNoIndexDiffArgs(filePath),
    cwd: repoRoot,
    signal,
    acceptedExitCodes: [0, 1], // 1 = files differ
    label: "hunk diff (untracked)",
  });
  return {
    kind: "patch",
    path: filePath,
    patchText: transcodePatch(result.stdout, settings),
    isUntracked: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Exact file sources (plan §6.2, Q9)                                          */
/* -------------------------------------------------------------------------- */

/** Collect a byte stream with a hard ceiling; kills the process past it. */
async function collectBytesWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  kill: () => void,
): Promise<{ bytes: Uint8Array; tooLarge: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      chunks.push(value);
      total += value.length;
      if (total > maxBytes) {
        kill();
        await reader.cancel().catch(() => undefined);
        return { bytes: new Uint8Array(0), tooLarge: true };
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: merged, tooLarge: false };
}

/**
 * Read one `git show <object-spec>` blob with per-(path, side) probing (Q9):
 * binary sources decline, oversized ones report the limit, everything else
 * is transcoded with the encoding probed from the blob bytes themselves.
 */
async function readGitObject(
  repoRoot: string,
  objectSpec: string,
  filePath: string,
  settings: ExtensionSettings,
): Promise<ExtensionVcsFileSourceResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["git", "show", objectSpec], {
      cwd: repoRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return null;
  }

  let collected: { bytes: Uint8Array; tooLarge: boolean };
  let exitCode = 0;
  try {
    const [out, , code] = await Promise.all([
      collectBytesWithLimit(proc.stdout, SOURCE_TEXT_MAX_BYTES, () => proc.kill()),
      // Stderr must be drained even when unused, or a full pipe can deadlock.
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    collected = out;
    exitCode = code;
  } catch {
    proc.kill();
    return null;
  }

  if (collected.tooLarge) return { kind: "too-large", maxBytes: SOURCE_TEXT_MAX_BYTES };
  if (exitCode !== 0) {
    // Missing side/path ("does not exist in 'HEAD'") and other expected
    // read failures degrade to null exactly like the built-in reader; a
    // diagnostic surface can be added with hunk.log if ever needed.
    return null;
  }
  return transcodeSourceBytes(collected.bytes, filePath, settings);
}

/** Read one worktree file with per-side probing and the same gates. */
function readWorktreeSource(
  absolutePath: string,
  filePath: string,
  settings: ExtensionSettings,
): ExtensionVcsFileSourceResult {
  let bytes: Uint8Array;
  try {
    const stat = fs.statSync(absolutePath);
    if (stat.size > SOURCE_TEXT_MAX_BYTES) {
      return { kind: "too-large", maxBytes: SOURCE_TEXT_MAX_BYTES };
    }
    bytes = fs.readFileSync(absolutePath);
  } catch {
    return null; // missing or unreadable — no content side
  }
  return transcodeSourceBytes(bytes, filePath, settings);
}

/** Shared tail: binary decline → probe → transcode. */
function transcodeSourceBytes(
  bytes: Uint8Array,
  filePath: string,
  settings: ExtensionSettings,
): ExtensionVcsFileSourceResult {
  if (isLikelyBinary(bytes)) return null;
  const encoding = detectEncoding(bytes, filePath, settings);
  return transcode(bytes, encoding);
}

function endpointCacheKey(endpoint: GitDiffEndpoint, indexCacheKey: string): string {
  if (endpoint.kind === "git-ref") return `ref:${endpoint.ref}`;
  if (endpoint.kind === "index") return `index:${indexCacheKey}`;
  return endpoint.kind; // "worktree" | "none"
}

/** Hash the staged-entry list so index-side cache keys track index content. */
async function gitIndexCacheKey(repoRoot: string): Promise<string> {
  const result = await runGitBytes({
    args: ["ls-files", "--stage", "-z"],
    cwd: repoRoot,
    label: "hunk diff (source index)",
  });
  return createHash("sha256")
    .update(Buffer.from(result.stdout).toString("utf8"))
    .digest("hex");
}

/**
 * Stable identity for one complete old/new source snapshot, plus the reader
 * itself (plan §6.2). Built-in shape `git-source-v1:<old>:<new>` extended
 * with the encoding-config fingerprint per side (Q9): any encoding config
 * change invalidates cached highlight state without touching endpoint keys.
 */
async function buildSourceCapability(
  repoRoot: string,
  settings: ExtensionSettings,
  endpoints: GitDiffEndpoints,
): Promise<{ readFileSource: ExtensionVcsFileSourceReader; sourceCacheKey: string }> {
  const needsIndex = endpoints.old.kind === "index" || endpoints.new.kind === "index";
  const indexCacheKey = needsIndex ? await gitIndexCacheKey(repoRoot) : "unused";

  const oldKey = endpointCacheKey(endpoints.old, indexCacheKey);
  const newKey = endpointCacheKey(endpoints.new, indexCacheKey);
  const encodingFingerprint = configFingerprint(settings);
  const sourceCacheKey = [
    "git-source-v1",
    oldKey,
    encodingFingerprint,
    newKey,
    encodingFingerprint,
  ].join(":");

  const readFileSource: ExtensionVcsFileSourceReader = ({
    path,
    previousPath,
    changeType,
    side,
  }) => {
    if (side === "old") {
      if (changeType === "new") return Promise.resolve(null);
      return readSourceSide(endpoints.old, previousPath ?? path);
    }
    if (changeType === "deleted") return Promise.resolve(null);
    return readSourceSide(endpoints.new, path);
  };

  async function readSourceSide(
    endpoint: GitDiffEndpoint,
    filePath: string,
  ): Promise<ExtensionVcsFileSourceResult> {
    try {
      switch (endpoint.kind) {
        case "none":
          return null;
        case "git-ref":
          return await readGitObject(repoRoot, `${endpoint.ref}:${filePath}`, filePath, settings);
        case "index":
          return await readGitObject(repoRoot, `:${filePath}`, filePath, settings);
        case "worktree":
          return readWorktreeSource(join(repoRoot, filePath), filePath, settings);
      }
    } catch {
      return null; // exact-source reads degrade, never fail the review
    }
  }

  return { readFileSource, sourceCacheKey };
}

function configFingerprint(settings: ExtensionSettings): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    JSON.stringify({
      encodings: settings.encodings,
      fallback: settings.fallback,
      overrides: settings.overrides.map((rule) => [rule.glob, rule.encoding, rule.target]),
    }),
  );
  return hasher.digest("hex").slice(0, 12);
}

/* -------------------------------------------------------------------------- */
/* working-tree-diff load                                                      */
/* -------------------------------------------------------------------------- */

async function loadWorkingTreeDiff(
  input: ExtensionVcsDiffInput,
  context: ExtensionVcsLoadContext,
  settings: ExtensionSettings,
): Promise<ExtensionVcsPatchResult> {
  const { cwd, signal } = context;
  const label = commandLabel(input);

  const repoRoot = await resolveGitRepoRoot(input, { cwd, signal });
  const repoName = repoRoot.split(/[\\/]/).filter(Boolean).pop() ?? repoRoot;

  // Endpoints decide both ref-backed source reads and untracked inclusion:
  // untracked files belong exactly when the new side is the live worktree
  // (no range, or a range resolving to one positive revision and no
  // negatives — the built-in's isWorkingTreeGitDiffInput rule).
  const endpoints = await resolveGitDiffEndpoints(input, { cwd, repoRoot, signal });
  const includeUntracked =
    input.options.excludeUntracked !== true && endpoints?.new.kind === "worktree";

  // Stats before the patch so files too large to render are excluded from
  // the diff instead of generating output nobody reads (R1).
  const numstatText = await runGitText({
    args: buildGitDiffNumstatArgs(input),
    cwd,
    signal,
    label,
  });
  const largeTrackedFiles = parseGitNumstat(numstatText).filter((file) => {
    if (file.additions + file.deletions > LARGE_DIFF_FILE_MAX_LINES) return true;
    try {
      return fs.statSync(join(repoRoot, file.path)).size > LARGE_DIFF_FILE_MAX_BYTES;
    } catch {
      return false;
    }
  });

  // Main patch — byte mode, then the shared transcode pipeline (ADR-0001).
  const patchResult = await runGitBytes({
    args: buildGitDiffArgs(
      input,
      largeTrackedFiles.map((file) => file.path),
    ),
    cwd,
    signal,
    label,
  });
  const patchText = transcodePatch(patchResult.stdout, settings);

  const extraFiles: ExtensionVcsExtraFile[] = largeTrackedFiles.map(
    (file): ExtensionVcsExtraFile => ({
      kind: "skipped",
      path: file.path,
      reason: "too-large",
      changeType: "change",
      stats: { additions: file.additions, deletions: file.deletions },
    }),
  );

  if (includeUntracked) {
    const statusText = await runGitText({
      args: buildGitStatusArgs(input),
      cwd,
      signal,
      label,
    });
    const untrackedPaths = parseUntrackedFilePaths(statusText).filter((filePath) =>
      isReviewableUntrackedPath(repoRoot, filePath),
    );
    for (const filePath of untrackedPaths) {
      const entry = await buildUntrackedExtraFile(repoRoot, filePath, settings, signal);
      if (entry) extraFiles.push(entry);
    }
  }

  const capability = endpoints
    ? await buildSourceCapability(repoRoot, settings, endpoints)
    : undefined;

  const rangeTitle = describeGitDiffTitleRange(input);
  const title = input.staged
    ? `${repoName} staged changes`
    : rangeTitle
      ? `${repoName} ${rangeTitle}`
      : `${repoName} working tree`;

  return {
    repoRoot,
    sourceLabel: repoRoot,
    title,
    patchText,
    ...(capability ?? {}),
    extraFiles,
  };
}

/**
 * Create the custom-encoding Git adapter for one loaded configuration.
 *
 * Detection priority sits above the built-in baseline (plan §6): once this
 * adapter claims a repository it takes over every VCS operation for it, so
 * the command surface is replicated exactly (ADR-0004). The settings are
 * closed over per adapter, so differently-configured instances coexist.
 */
export function createEncodingGitAdapter(settings: ExtensionSettings): ExtensionVcsAdapter {
  return {
    id: "hunk-custom-encoding",
    name: "Git (custom encoding)",
    detect: detectGitRepo,
    detectionPriority: HUNK_VCS_DETECTION_BASELINE_PRIORITY + 10,
    operations: {
      "working-tree-diff": {
        load: (input, context) => loadWorkingTreeDiff(input, context, settings),
      },
      // "revision-show" / "stash-show": M3 (plan §6.3/6.4).
    },
    // history stays unimplemented (Q6): `hunk log` reports "not supported".
  };
}
