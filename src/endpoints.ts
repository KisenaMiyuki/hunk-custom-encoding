/**
 * Git diff endpoint resolution (plan §6.1 step 1, Q13).
 *
 * Replicates the built-in `resolveGitDiffEndpointsAsync`: which state each
 * side of a comparison names, so `readFileSource` can read blobs from the
 * exact revisions the patch was computed from. Resolved refs are full object
 * ids (stable `sourceCacheKey` inputs).
 */

import type { ExtensionVcsDiffInput } from "hunkdiff/extension";
import {
  commandLabel,
  isUnknownRevisionMessage,
  requireGitDiffRangeArg,
  runGitBytes,
  runGitText,
  translateGitExitFailure,
} from "./git";

/** One endpoint kind the adapter can read exact source from. */
export type GitDiffEndpoint =
  | { kind: "none" }
  | { kind: "git-ref"; ref: string }
  | { kind: "index" }
  | { kind: "worktree" };

export interface GitDiffEndpoints {
  old: GitDiffEndpoint;
  new: GitDiffEndpoint;
}

export interface ResolveEndpointsOptions {
  cwd: string;
  repoRoot: string;
  signal?: AbortSignal;
}

/** Parse "A...B" into its two refs, defaulting empty sides to HEAD as Git does. */
export function parseSymmetricDiffRange(range: string): { left: string; right: string } | null {
  // Runs of four or more dots are not a valid range; bail rather than
  // silently treating the first three as a symmetric-diff separator.
  if (/\.{4,}/.test(range)) return null;

  const parts = range.split("...");
  if (parts.length !== 2) return null;
  return { left: parts[0]! || "HEAD", right: parts[1]! || "HEAD" };
}

interface ResolvedRevisions {
  positives: string[];
  negatives: string[];
}

/** Resolve rev-parse output into positive and negative revisions for one range. */
async function resolveRangeRevisions(
  input: ExtensionVcsDiffInput,
  range: string,
  options: ResolveEndpointsOptions,
): Promise<ResolvedRevisions> {
  const text = await runGitText({
    args: ["rev-parse", "--revs-only", range],
    cwd: options.repoRoot,
    signal: options.signal,
    label: commandLabel(input),
    errorContext: input,
  });
  const revs = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    positives: revs.filter((rev) => !rev.startsWith("^")),
    negatives: revs.filter((rev) => rev.startsWith("^")).map((rev) => rev.slice(1)),
  };
}

/** Resolve one commit-ish ref, or null when the ref is unborn/unresolvable. */
async function tryResolveCommitRef(
  input: ExtensionVcsDiffInput,
  ref: string,
  options: ResolveEndpointsOptions,
): Promise<string | null> {
  const result = await runGitBytes({
    args: ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    cwd: options.repoRoot,
    signal: options.signal,
    label: commandLabel(input),
    errorContext: input,
    acceptedExitCodes: [0, 1, 128],
  });
  if (result.exitCode === 0) {
    return Buffer.from(result.stdout).toString("utf8").split("\n")[0]?.trim() || null;
  }
  // Built-in rule: unknown-revision failures mean the ref is unborn (or
  // unresolvable) and degrade to null; anything else is a real failure and
  // surfaces through the per-kind translation (built-in staged-branch rule).
  const stderr = result.stderrText.trim();
  if (stderr && !isUnknownRevisionMessage(stderr)) {
    throw translateGitExitFailure(input, stderr);
  }
  return null;
}

/**
 * Resolve the old/new endpoints implied by one `hunk diff` invocation.
 *
 * Returns `null` when the range maps to a shape that is not a single
 * old/new pair; callers then skip ref-backed source reads entirely rather
 * than guessing (built-in semantics).
 */
export async function resolveGitDiffEndpoints(
  input: ExtensionVcsDiffInput,
  options: ResolveEndpointsOptions,
): Promise<GitDiffEndpoints | null> {
  const { cwd, repoRoot, signal } = options;
  const label = commandLabel(input);
  const run = (args: string[], acceptedExitCodes: number[] = [0]) =>
    runGitText({ args, cwd: repoRoot, signal, label, acceptedExitCodes, errorContext: input });

  const range = requireGitDiffRangeArg(input);

  if (input.staged) {
    if (!range) {
      // Staged comparison: HEAD (or nothing, on an unborn branch) vs index.
      const headRef = await tryResolveCommitRef(input, "HEAD", options);
      return {
        old: headRef ? { kind: "git-ref", ref: headRef } : { kind: "none" },
        new: { kind: "index" },
      };
    }

    const { positives, negatives } = await resolveRangeRevisions(input, range, options);
    if (positives.length === 1 && negatives.length === 0) {
      return { old: { kind: "git-ref", ref: positives[0]! }, new: { kind: "index" } };
    }
    return null;
  }

  if (!range) {
    return { old: { kind: "index" }, new: { kind: "worktree" } };
  }

  // `git diff A...B` compares merge-base(A, B) against B, not HEAD or the
  // working tree. Resolve the merge base explicitly so expanded source rows
  // read from the same revisions the diff was computed from (Q13).
  const symmetric = parseSymmetricDiffRange(range);
  if (symmetric) {
    let mergeBase: string | undefined;
    try {
      mergeBase = (await run(["merge-base", symmetric.left, symmetric.right]))
        .split("\n")[0]
        ?.trim();
    } catch (error) {
      if (signal?.aborted) throw error;
      return null; // no common ancestor — no safe old/new mapping
    }
    if (!mergeBase) return null;

    const rightRef = await tryResolveCommitRef(input, symmetric.right, options);
    if (!rightRef) return null;

    return { old: { kind: "git-ref", ref: mergeBase }, new: { kind: "git-ref", ref: rightRef } };
  }

  const { positives, negatives } = await resolveRangeRevisions(input, range, options);

  if (positives.length === 1 && negatives.length === 0) {
    // Single revision diffs against the working tree.
    return { old: { kind: "git-ref", ref: positives[0]! }, new: { kind: "worktree" } };
  }

  if (positives.length === 1 && negatives.length === 1) {
    // `A..B` compares A against B; the negative side supplies the base.
    return {
      old: { kind: "git-ref", ref: negatives[0]! },
      new: { kind: "git-ref", ref: positives[0]! },
    };
  }

  // Multi-revision shapes (octopus merges, multi-positive sets) have no safe
  // old/new mapping; null disables ref-backed source reads.
  return null;
}
