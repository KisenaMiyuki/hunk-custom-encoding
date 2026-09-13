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

import {
  HunkExtensionUserError,
  type ExtensionVcsDiffInput,
  type ExtensionVcsShowInput,
  type ExtensionVcsStashShowInput,
} from "hunkdiff/extension";

/** Every VCS review input whose Git commands carry per-kind error translation. */
export type GitBackedInput = ExtensionVcsDiffInput | ExtensionVcsShowInput | ExtensionVcsStashShowInput;

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
 * Moved-line colors (M3, built-in replica): deterministic palette so the
 * patch parser can classify Git's ANSI output reliably (types.d.ts §598-606).
 */
export const GIT_MOVED_LINE_COLOR_CONFIG = [
  "-c",
  "color.diff.oldMoved=magenta bold",
  "-c",
  "color.diff.oldMovedAlternative=magenta bold",
  "-c",
  "color.diff.oldMovedDimmed=magenta dim",
  "-c",
  "color.diff.oldMovedAlternativeDimmed=magenta dim",
  "-c",
  "color.diff.newMoved=cyan bold",
  "-c",
  "color.diff.newMovedAlternative=cyan bold",
  "-c",
  "color.diff.newMovedDimmed=cyan dim",
  "-c",
  "color.diff.newMovedAlternativeDimmed=cyan dim",
] as const;

/** Which moved-line mode (if any) a patch command should request from Git. */
export interface GitColorMovedOptions {
  mode: string;
  whitespaceMode?: string;
}

const GIT_BOOLEAN_TRUE_VALUES = new Set(["true", "yes", "on", "1", "always"]);
const GIT_BOOLEAN_FALSE_VALUES = new Set(["false", "no", "off", "0", "never"]);

/** Normalize Git's `diff.colorMoved` config into the mode to request (built-in replica). */
export function normalizeGitColorMovedMode(value: string | undefined): string | null | undefined {
  if (!value) return undefined;

  const normalized = value.toLowerCase();
  if (GIT_BOOLEAN_FALSE_VALUES.has(normalized) || normalized === "no") return null;
  if (GIT_BOOLEAN_TRUE_VALUES.has(normalized)) return "zebra";

  return value;
}

/** Git color flags for patch commands — ANSI only when move classes are needed. */
function gitPatchColorArgs(colorMoved: GitColorMovedOptions | null): string[] {
  if (!colorMoved) return ["--no-color"];

  return [
    "--color=always",
    `--color-moved=${colorMoved.mode}`,
    ...(colorMoved.whitespaceMode ? [`--color-moved-ws=${colorMoved.whitespaceMode}`] : []),
  ];
}

/** Prepend the deterministic moved-line color config (built-in replica). */
function withGitMovedLineColorConfig(
  args: string[],
  colorMoved: GitColorMovedOptions | null,
): string[] {
  if (!colorMoved) return args;

  return [...GIT_MOVED_LINE_COLOR_CONFIG, ...args];
}

/**
 * Resolve moved-line configuration from `git config` (M3, built-in replica of
 * `resolveGitColorMovedOptionsAsync`): explicit `diff.colorMoved=false` wins,
 * a boolean true becomes `zebra`, an explicit mode passes through as-is, and
 * unset falls back to the review's `--color-moved` flag. `diff.colorMovedWS`
 * is carried raw whenever a mode is resolved.
 */
export async function resolveGitColorMovedOptions(
  input: GitBackedInput,
  options: { cwd: string; signal?: AbortSignal } = { cwd: process.cwd() },
): Promise<GitColorMovedOptions | null> {
  const readConfig = async (key: string): Promise<string | undefined> => {
    const result = await runGitBytes({
      args: ["config", "--get", key],
      cwd: options.cwd,
      signal: options.signal,
      acceptedExitCodes: [0, 1],
      label: commandLabel(input),
      errorContext: input,
    });
    return result.exitCode === 0
      ? Buffer.from(result.stdout).toString("utf8").trim() || undefined
      : undefined;
  };

  const gitMode = normalizeGitColorMovedMode(await readConfig("diff.colorMoved"));
  if (gitMode === null) return null;

  const mode = gitMode ?? (input.options.colorMoved ? "zebra" : undefined);
  if (!mode) return null;

  return { mode, whitespaceMode: await readConfig("diff.colorMovedWS") };
}

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

/** Human label for one review input, used in error messages (built-in replica). */
export function commandLabel(input: GitBackedInput): string {
  if (input.kind === "show") {
    return input.ref ? `hunk show ${input.ref}` : "hunk show";
  }
  if (input.kind === "stash-show") {
    return input.ref ? `hunk stash show ${input.ref}` : "hunk stash show";
  }
  if (input.staged) return "hunk diff --staged";
  if (input.rangeEndpoints) {
    return `hunk diff ${input.rangeEndpoints.from}..${input.rangeEndpoints.to}`;
  }
  return input.range ? `hunk diff ${input.range}` : "hunk diff";
}

/** Compact range form for titles and error messages (built-in `describeDiffRange`). */
export function describeDiffRange(input: ExtensionVcsDiffInput): string | undefined {
  return input.rangeEndpoints
    ? `${input.rangeEndpoints.from}..${input.rangeEndpoints.to}`
    : input.range;
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
  colorMoved: GitColorMovedOptions | null = null,
): string[] {
  const args = ["diff", "--no-ext-diff", "--find-renames", ...gitPatchColorArgs(colorMoved)];

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

  return withNormalizedDiffPrefixes(withGitMovedLineColorConfig(args, colorMoved));
}

/**
 * The exact `git show` arguments for commit review (M3, built-in replica).
 * The ref is validated against option injection; pathspecs land after `--`.
 */
export function buildGitShowArgs(
  input: ExtensionVcsShowInput,
  colorMoved: GitColorMovedOptions | null = null,
): string[] {
  const args = [
    "show",
    "--format=",
    "--no-ext-diff",
    "--find-renames",
    ...gitPatchColorArgs(colorMoved),
  ];

  if (input.ref) {
    args.push(requireGitRevisionArg(commandLabel(input), input.ref));
  }

  appendGitPathspecs(args, input.pathspecs);
  return withNormalizedDiffPrefixes(withGitMovedLineColorConfig(args, colorMoved));
}

/**
 * The exact `git stash show -p` arguments for stash review (M3, built-in
 * replica): no pathspec support — `git stash show -p [<ref>]` only.
 */
export function buildGitStashShowArgs(
  input: ExtensionVcsStashShowInput,
  colorMoved: GitColorMovedOptions | null = null,
): string[] {
  const args = [
    "stash",
    "show",
    "-p",
    "--no-ext-diff",
    "--find-renames",
    ...gitPatchColorArgs(colorMoved),
  ];

  if (input.ref) {
    args.push(requireGitRevisionArg(commandLabel(input), input.ref));
  }

  return withNormalizedDiffPrefixes(withGitMovedLineColorConfig(args, colorMoved));
}

/**
 * Resolve one ref to the exact commit id `git show` should be pinned to
 * (built-in `resolveGitCommitRefAsync`): `--end-of-options` keeps a hostile
 * ref from being parsed as flags. Resolving happens once per load so patch
 * args, source endpoints (`<id>^` ↔ `<id>`) and cache keys agree.
 */
export async function resolveGitCommitRef(
  input: GitBackedInput,
  ref: string,
  options: { cwd: string; signal?: AbortSignal },
): Promise<string> {
  const text = await runGitText({
    args: ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    cwd: options.cwd,
    signal: options.signal,
    label: commandLabel(input),
    errorContext: input,
  });
  return text.split("\n")[0]!.trim();
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
  /**
   * The review input the command belongs to. Given this, failures translate
   * with the built-in's per-kind messages (`hunk show` ref errors, missing
   * stash entries, range-aware revision errors); plain-label generic
   * translation applies otherwise (helper queries with no review identity).
   */
  errorContext?: GitBackedInput;
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
      const failureStderr = stderrText.trim() || `Command failed: git ${args.join(" ")}`;
      throw options.errorContext
        ? translateGitExitFailure(options.errorContext, failureStderr)
        : translateGenericGitFailure(label, failureStderr);
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

export function isUnknownRevisionMessage(stderr: string): boolean {
  return GIT_UNKNOWN_REVISION_FRAGMENTS.some((fragment) => stderr.includes(fragment));
}

function isMissingGitRepoMessage(stderr: string): boolean {
  return stderr.includes("not a git repository");
}

function isNoStashEntriesMessage(stderr: string): boolean {
  return ["No stash entries found.", "log for 'stash' only has"].some((fragment) =>
    stderr.includes(fragment),
  );
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

function createMissingRepoError(input: GitBackedInput): HunkExtensionUserError {
  return new HunkExtensionUserError(`\`${commandLabel(input)}\` must be run inside a Git repository.`, {
    suggestions:
      input.kind === "vcs"
        ? [
            "Run the command from a Git checkout, or compare files directly instead:",
            "  hunk diff --files <before-file> <after-file>",
            "  hunk patch <file.patch>",
          ]
        : ["Run the command from a Git checkout."],
  });
}

function createMissingStashError(input: ExtensionVcsStashShowInput): HunkExtensionUserError {
  if (input.ref) {
    return new HunkExtensionUserError(
      `\`${commandLabel(input)}\` could not resolve stash entry \`${input.ref}\`.`,
      { suggestions: ["List available stashes with `git stash list`, then try again."] },
    );
  }
  return new HunkExtensionUserError("`hunk stash show` could not find a stash entry to show.", {
    suggestions: [
      "Create one with `git stash push`, or pass an explicit stash ref like `hunk stash show stash@{0}`.",
    ],
  });
}

function createInvalidRevisionError(input: GitBackedInput): HunkExtensionUserError {
  if (input.kind === "vcs") {
    const endpoints = input.rangeEndpoints;
    return new HunkExtensionUserError(
      `\`${commandLabel(input)}\` could not resolve Git revision or range \`${describeDiffRange(input)}\`.`,
      {
        suggestions: [
          "Check the revision or range and try again.",
          ...(endpoints
            ? [
                `To limit the review to a path, separate it: \`hunk diff ${endpoints.from} -- ${endpoints.to}\`.`,
              ]
            : []),
        ],
      },
    );
  }

  const ref = input.ref ?? "HEAD";
  return new HunkExtensionUserError(
    `\`${commandLabel(input)}\` could not resolve Git ref \`${ref}\`.`,
    { suggestions: ["Check the ref name and try again."] },
  );
}

function createGenericGitError(input: GitBackedInput, stderr: string): HunkExtensionUserError {
  return new HunkExtensionUserError(`\`${commandLabel(input)}\` failed.`, {
    suggestions: [firstGitErrorLine(stderr)],
  });
}

/** Translate one non-accepted git exit using the review input's identity (built-in replica). */
export function translateGitExitFailure(
  input: GitBackedInput,
  stderr: string,
): HunkExtensionUserError {
  if (isMissingGitRepoMessage(stderr)) {
    return createMissingRepoError(input);
  }
  if (
    input.kind === "stash-show" &&
    (isNoStashEntriesMessage(stderr) || isUnknownRevisionMessage(stderr))
  ) {
    return createMissingStashError(input);
  }
  if (input.kind === "vcs" && describeDiffRange(input) && isUnknownRevisionMessage(stderr)) {
    return createInvalidRevisionError(input);
  }
  if (input.kind === "show" && isUnknownRevisionMessage(stderr)) {
    return createInvalidRevisionError(input);
  }
  if (input.kind === "stash-show" && input.ref && isUnknownRevisionMessage(stderr)) {
    return createMissingStashError(input);
  }
  return createGenericGitError(input, stderr);
}

/** Translate one non-accepted git exit for a helper query with no review identity. */
export function translateGenericGitFailure(label: string, stderr: string): HunkExtensionUserError {
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
    `Git is required for \`${label}\`, but \`git\` was not found in PATH.`,
    { suggestions: ["Install Git or make it available on PATH, then try again.", detail] },
  );
}
