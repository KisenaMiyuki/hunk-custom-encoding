/**
 * Unit tests for src/review-info.ts (M4 — built-in `@hunk/vcs/review-info`
 * `commitReviewInfo` replica).
 */
import { describe, expect, test } from "bun:test";
import type { VcsReviewCommit } from "../src/git";
import { commitReviewInfo, vcsReviewAuthorLabel } from "../src/review-info";

const commit = (overrides: Partial<VcsReviewCommit> = {}): VcsReviewCommit => ({
  revisionId: "a".repeat(40),
  displayId: "abcd1234",
  parentRevisionIds: ["b".repeat(40)],
  subject: "subject line",
  authorName: "Jane Doe",
  authorEmail: "jane@example.test",
  authoredAt: "2026-09-12T12:00:00+08:00",
  ...overrides,
});

describe("vcsReviewAuthorLabel", () => {
  test("github noreply addresses resolve to the account name", () => {
    expect(vcsReviewAuthorLabel(commit({ authorEmail: "12345+octo@users.noreply.github.com" }))).toBe("octo");
    expect(vcsReviewAuthorLabel(commit({ authorEmail: "Octo@users.noreply.github.com" }))).toBe("Octo");
  });

  test("plain emails resolve to their local part", () => {
    expect(vcsReviewAuthorLabel(commit())).toBe("jane");
  });

  test("missing email falls back to the author name", () => {
    expect(vcsReviewAuthorLabel(commit({ authorEmail: undefined }))).toBe("Jane Doe");
    expect(vcsReviewAuthorLabel(commit({ authorEmail: "" }))).toBe("Jane Doe");
  });
});

describe("commitReviewInfo", () => {
  test("flat descriptor with parsed date", () => {
    const info = commitReviewInfo("Git", commit());
    expect(info).toEqual({
      kind: "commit",
      provider: "Git",
      title: "subject line",
      revision: "a".repeat(40),
      displayRevision: "abcd1234",
      author: "jane",
      authoredAt: "2026-09-12T12:00:00+08:00",
    });
  });

  test("control characters collapse; empty subject gets the placeholder", () => {
    const info = commitReviewInfo("Git", commit({ subject: "a\u0000b\tc\nd" }));
    expect(info.title).toBe("a b c d");
    expect(commitReviewInfo("Git", commit({ subject: "  " })).title).toBe("(no commit message)");
  });

  test("unparseable dates are omitted", () => {
    const info = commitReviewInfo("Git", commit({ authoredAt: "not-a-date" }));
    expect("authoredAt" in info).toBe(false);
  });

  test("long subjects truncate on code-point boundaries within transport bytes", () => {
    const subject = "中".repeat(2000); // 3 bytes per char > 2 KiB transport budget
    const info = commitReviewInfo("Git", commit({ subject }));
    expect(info.title.length).toBeLessThan(subject.length);
    expect(info.title).toMatch(/^中+$/u);
    expect(new TextEncoder().encode(info.title).byteLength).toBeLessThanOrEqual(2048);
  });
});
