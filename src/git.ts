/**
 * Git command execution layer (plan §3.1, ADR-0004).
 *
 * The built-in adapter's exact argument shapes, replicated from
 * packages/hunk-git/src/commands.ts (verified 2026-09). The difference:
 * every command that produces patch output runs in BYTE mode and hands raw
 * `Uint8Array` stdout to the transcode pipeline, instead of decoding it as
 * UTF-8 first (plan §1.2 — the whole point of this extension).
 *
 * Pure helpers (arg assembly, numstat parsing) are exported for unit tests;
 * spawning lives in `runGitBytes`.
 */

import { HunkExtensionUserError, type ExtensionVcsDiffInput } from "hunkdiff/extension";

/**
 * Force byte-safe path quoting and canonical a/ b/ prefixes so user/repo git
 * config cannot mangle patch output (R1 — identical to the built-in set).
 */
export const DIFF_PREFIX_NORMALIZATION_ARGS = [
  "-c",
  "core.quotePath=true",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
] as const;

/** Large-diff gates (plan R1: lines >20000 or on-disk >1MB). */
export const LARGE_DIFF_FILE_MAX_LINES = 20_000;
export const LARGE_DIFF_FILE_MAX_BYTES = 1_000_000;

/** Exact source reads larger than this are declined (plan §6.2). */
export const SOURCE_TEXT_MAX_BYTES = 1_000_000;

/**
 * Return one caller-supplied revision or range argument, refusing
 * option-like values (injected content that Git would parse as a flag).
 */
export function requireGitRevisionArg(label: string, value: string): string {
  if (value.length === 0) {
    throw new HunkExtensionUserError(`\`${label}\` refused an empty revision.`, {
      suggestions: ["Pass a non-empty revision or range and try again."],
    });
  }
  if (value.startsWith("-")) {
    throw new HunkExtensionUserError(
      `\`${label}\` refused revision \`${value}\` because it looks like a Git option.`,
      { suggestions: ["Pass a plain revision or range, such as `HEAD` or `main..feature`."] },
    );
  }
  return value;
}

/** The range argument for one diff input, validating each endpoint. */
export function requireGitDiffRangeArg(input: ExtensionVcsDiffInput): string | undefined {
  if (input.rangeEndpoints) {
    const from = requireGitRevisionArg(commandLabel(input), input.rangeEndpoints.from);
    const to = requireGitRevisionArg(commandLabel(input), input.rangeEndpoints.to);
    return `${from}..${to}`;
  }
  return input.range ? requireGitRevisionArg(commandLabel(input), input.range) : undefined;
}

/** Human label for one diff input, used in error messages. */
export function commandLabel(input: ExtensionVcsDiffInput): string {
  if (input.staged) return "hunk diff --staged";
  if (input.rangeEndpoints) {
    return `hunk diff ${input.rangeEndpoints.from}..${input.rangeEndpoints.to}`;
  }
  return input.range ? `hunk diff ${input.range}` : "hunk diff";
}

function withNormalizedDiffPrefixes(args: string[]): string[] {
  return [...DIFF_PREFIX_NORMALIZATION_ARGS, ...args];
}

function appendGitPathspecs(args: string[], pathspecs?: string[]): void {
  if (!pathspecs || pathspecs.length === 0) return;
  args.push("--", ...pathspecs);
}

/** The exact `git diff` arguments for the working-tree and range review path (R1). */
export function buildGitDiffArgs(
  input: ExtensionVcsDiffInput,
  excludedPathspecs: string[] = [],
): string[] {
  // M2 always diffs without color (plan §6.5); ANSI passthrough is M3.
  const args = ["diff", "--no-ext-diff", "--find-renames", "--no-color"];

  if (input.staged) args.push("--staged");

  const range = requireGitDiffRangeArg(input);
  if (range) args.push(range);

  if (excludedPathspecs.length > 0) {
    args.push(
      "--",
      ...(input.pathspecs ?? []),
      ...excludedPathspecs.map((path) => `:(exclude)${path}`),
    );
  } else {
    appendGitPathspecs(args, input.pathspecs);
  }

  return withNormalizedDiffPrefixes(args);
}

/** The cheap tracked-file stats query used to skip huge diffs before patch output. */
export function buildGitDiffNumstatArgs(input: ExtensionVcsDiffInput): string[] {
  const args = ["diff", "--no-ext-diff", "--find-renames", "--no-color", "--numstat", "-z"];

  if (input.staged) args.push("--staged");

  const range = requireGitDiffRangeArg(input);
  if (range) args.push(range);

  appendGitPathspecs(args, input.pathspecs);
  return withNormalizedDiffPrefixes(args);
}

/** The porcelain status query that discovers untracked files for working-tree review. */
export function buildGitStatusArgs(input: ExtensionVcsDiffInput): string[] {
  const args = [
    "--no-optional-locks",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ];
  appendGitPathspecs(args, input.pathspecs);
  return args;
}

/**
 * The self-produced patch query for one untracked file (ADR-0002): run in
 * byte mode, then feed the same transcode pipeline as tracked diffs.
 *
 * Paths that would parse as options are prefixed with `./`; `git diff
 * --no-index` takes exactly two path operands, so there is no `--` to hide
 * behind. Exit code 1 means "files differ" and is accepted.
 */
export function buildGitNoIndexDiffArgs(path: string): string[] {
  const safePath = path.startsWith("-") ? `./${path}` : path;
  return withNormalizedDiffPrefixes([
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--no-index",
    "/dev/null",
    safePath,
  ]);
}

/** Parse `git diff --numstat -z` output (built-in replica, rename entries dropped). */
export interface GitNumstatFile {
  path: string;
  additions: number;
  deletions: number;
}

export function parseGitNumstat(text: string): GitNumstatFile[] {
  return text
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const [additionsText, deletionsText, path] = entry.split("\t");
      if (!additionsText || !deletionsText || !path) return [];

      const additions = Number.parseInt(additionsText, 10);
      const deletions = Number.parseInt(deletionsText, 10);
      if (!Number.isFinite(additions) || !Number.isFinite(deletions)) return [];

      return [{ path: path!, additions, deletions }];
    });
}

/** Parse porcelain status output down to repo-root-relative untracked paths. */
export function parseUntrackedFilePaths(statusText: string): string[] {
  return statusText
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => (entry.startsWith("?? ") ? [entry.slice(3)] : []));
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                   */
/* -------------------------------------------------------------------------- */

export interface RunGitBytesOptions {
  /** Full git arguments (without the "git" program itself). */
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  /** Exit codes that are not failures; defaults to `[0]`. */
  acceptedExitCodes?: number[];
  /** Set `GIT_OPTIONAL_LOCKS=0` for read-only queries. */
  preventOptionalLocks?: boolean;
  /** Human label for error messages, e.g. `hunk diff`. */
  label: string;
}

export interface GitBytesResult {
  stdout: Uint8Array;
  stderrText: string;
  exitCode: number;
}

/**
 * Spawn one git command and collect stdout as raw bytes.
 *
 * The raw-byte contract is what lets the transcode pipeline decode file
 * content with the right encoding; stderr is decoded lossily for messages.
 * Cancellation kills the process and throws the signal's abort reason.
 */
export async function runGitBytes(options: RunGitBytesOptions): Promise<GitBytesResult> {
  const {
    args,
    cwd,
    signal,
    acceptedExitCodes = [0],
    preventOptionalLocks = false,
    label,
  } = options;

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(preventOptionalLocks
        ? { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }
        : {}),
    });
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    throw createMissingGitExecutableError(label, error);
  }

  const killOnAbort = () => proc.kill();
  signal?.addEventListener("abort", killOnAbort, { once: true });
  try {
    const [stdoutBuffer, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (signal?.aborted) signal.throwIfAborted();
    if (!acceptedExitCodes.includes(exitCode)) {
      throw translateGitExitFailure(
        label,
        stderrText.trim() || `Command failed: git ${args.join(" ")}`,
      );
    }
    return { stdout: new Uint8Array(stdoutBuffer), stderrText, exitCode };
  } finally {
    signal?.removeEventListener("abort", killOnAbort);
  }
}

/** Run one git command, returning its stdout decoded as UTF-8 (lossy, built-in style). */
export async function runGitText(options: Omit<RunGitBytesOptions, "label"> & {
  label: string;
}): Promise<string> {
  const result = await runGitBytes(options);
  return Buffer.from(result.stdout).toString("utf8");
}

/* -------------------------------------------------------------------------- */
/* Failure translation (built-in replica)                                      */
/* -------------------------------------------------------------------------- */

const GIT_UNKNOWN_REVISION_FRAGMENTS = [
  "bad revision",
  "unknown revision or path not in the working tree",
  "ambiguous argument",
  "Needed a single revision",
];

function isUnknownRevisionMessage(stderr: string): boolean {
  return GIT_UNKNOWN_REVISION_FRAGMENTS.some((fragment) => stderr.includes(fragment));
}

function isMissingGitRepoMessage(stderr: string): boolean {
  return stderr.includes("not a git repository");
}

function trimGitPrefix(message: string): string {
  return message.replace(/^(fatal|error):\s*/i, "").trim();
}

function firstGitErrorLine(stderr: string): string {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean);
  return trimGitPrefix(line ?? stderr.trim()) || "Git command failed.";
}

/** Translate one non-accepted git exit into a user-facing error. */
export function translateGitExitFailure(label: string, stderr: string): HunkExtensionUserError {
  if (isMissingGitRepoMessage(stderr)) {
    return new HunkExtensionUserError(`\`${label}\` must be run inside a Git repository.`, {
      suggestions: ["Run the command from a Git checkout."],
    });
  }
  if (isUnknownRevisionMessage(stderr)) {
    return new HunkExtensionUserError(
      `\`${label}\` could not resolve Git revision or range.`,
      { suggestions: ["Check the revision or range and try again."] },
    );
  }
  return new HunkExtensionUserError(`\`${label}\` failed.`, {
    suggestions: [firstGitErrorLine(stderr)],
  });
}

function createMissingGitExecutableError(label: string, error: unknown): HunkExtensionUserError {
  const detail = error instanceof Error ? error.message : String(error);
  return new HunkExtensionUserError(
    `Git is required for \`${label}\`, but the executable could not be spawned.`,
    { suggestions: ["Install Git or make it available on PATH, then try again.", detail] },
  );
}
