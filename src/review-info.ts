/**
 * Review descriptor construction (M4 — built-in `@hunk/vcs/review-info`
 * `commitReviewInfo` replica). Pure functions only (ADR-0003): sanitizing,
 * byte-bounded truncation and the offline author label live here.
 */

import type { VcsReviewCommit } from "./git";

/** Remove terminal controls and collapse one provider field to a display-safe line. */
function sanitizeReviewText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Truncate one field without splitting Unicode code points or exceeding transport bytes. */
function truncateReviewText(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let result = "";
  let bytes = 0;
  for (const character of sanitizeReviewText(value)) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

/** Resolve the same offline account-like author label used by interactive history. */
export function vcsReviewAuthorLabel(commit: VcsReviewCommit): string {
  const email = commit.authorEmail?.trim();
  if (email) {
    const github = email.match(/^(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com$/i);
    if (github?.[1]) return github[1];
    const separator = email.indexOf("@");
    if (separator > 0) return email.slice(0, separator);
  }
  return commit.authorName;
}

/** The descriptor the review surface shows above one directly reviewed commit. */
export interface CommitReviewDescriptor {
  kind: "commit";
  provider: string;
  title: string;
  revision: string;
  displayRevision: string;
  author: string;
  authoredAt?: string;
}

/** Build bounded metadata for one directly reviewed commit (built-in replica). */
export function commitReviewInfo(provider: string, commit: VcsReviewCommit): CommitReviewDescriptor {
  const authoredAt = Number.isNaN(Date.parse(commit.authoredAt)) ? undefined : commit.authoredAt;
  return {
    kind: "commit",
    provider: truncateReviewText(provider, 256),
    title: truncateReviewText(commit.subject, 2 * 1024) || "(no commit message)",
    revision: truncateReviewText(commit.revisionId, 512),
    displayRevision: truncateReviewText(commit.displayId, 64),
    author: truncateReviewText(vcsReviewAuthorLabel(commit), 512) || "Unknown author",
    ...(authoredAt === undefined ? {} : { authoredAt }),
  };
}
