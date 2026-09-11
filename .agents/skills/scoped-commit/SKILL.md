---
name: scoped-commit
description: "Write and create Git commit messages for any repository, formatting them in the Scoped Commits style that leads with the affected subsystem or module as `<scope>: <description>`. Use whenever the user asks to commit, write a commit message, draft or compose a commit, amend or review a commit, split changes into commits, or define a project's commit message conventions."
license: MIT
metadata:
  author: KisenaMiyuki
  version: "1.0.0"
---

# Scoped Commit

Format commit messages following [Scoped Commits](https://scopedcommits.com) so the commit log is quickly scannable. The subject starts with the *scope* — the subsystem, area, or module touched — because that is the most useful information to contributors, debuggers, and incident responders.

## Format

```text
<scope>: <description>

[optional body]

[optional trailer(s)]
```

- `<scope>` — the subsystem, area, or module the commit touches.
- `<description>` — a short summary of the change.
- `[optional body]` — detailed information about the change.
- `[optional trailer(s)]` — additional metadata, such as ticket references.

Reverts, merges, fixups, and other special commits may be formatted however is clearest. Projects using Scoped Commits often add rules for valid scopes and for description, body, and trailer formatting; follow the project's rules when they exist.

## Workflow

1. Inspect the change with `git diff --staged` and `git status`. Identify the single subsystem or module it primarily affects.
2. Look at recent history (`git log --oneline -20`) and any `CONTRIBUTING` guidance to reuse established scopes and phrasing.
3. Choose the scope and write the description using the rules below.
4. Add a body when the reason for the change is not obvious from the subject and diff.
5. Add trailers for metadata such as ticket numbers or co-authors.
6. Keep each commit to one scope and one concern. If staged changes span unrelated scopes, split them into separate commits.
7. Verify the final message before committing. Do not add AI attribution, tool names, or emojis unless the user or project explicitly asks.

## Choosing a Scope

- Prefer scopes already used in the project's history and documentation for consistency.
- Use the deepest stable name that identifies the area, mirroring the code layout when it is meaningful: `net/http/cookiejar`, `i2c/virtio`, `xwayland`.
- If a change covers multiple scopes, use a more general scope that encompasses them, list both scopes separated by a comma, or use `treewide`, `all`, or `global` when the whole tree is touched.
- If no scope fits, treat the commit as a special commit, drop the scope, and write a clear description.
- Avoid vague scopes such as `misc`, `stuff`, `general`, or `update`. A scope that could describe anything is not a scope.

## Writing the Description

- Use the imperative mood and present tense: "add", "fix", "remove", "mark", not "added" or "fixes".
- Keep it short and specific; aim for roughly 50 characters and stay under 72 when possible.
- Describe what the commit does, not how it makes you feel and not the review process.
- Do not prefix the description with a type such as `feat:`, `fix:`, or `chore:`. That is Conventional Commits, which Scoped Commits deliberately replaces.
- Omit the trailing period. Match the project's capitalization convention, which is usually lowercase after the scope.

## Body and Trailers

- Separate the subject from the body with one blank line, and wrap body lines at about 72 characters.
- Explain what changed and why. The diff already shows how; do not narrate it.
- Put ticket numbers where the project expects them. Common options are parentheses after the scope, `auth (PROJ-123): fix login bug`, or a trailer:

  ```text
  auth: fix login bug

  Validate the session before refreshing the token.

  Jira-Ticket: PROJ-123
  ```

- Use standard Git trailers such as `Co-authored-by:` and `Signed-off-by:` only when applicable.

## Examples

```text
i2c: virtio: mark device ready before registering the adapter
net/http/cookiejar: add godoc links
xwayland: 24.1.11 -> 24.1.12
gitlab-ci: update macOS image
auth (PROJ-123): fix login bug
```

## Anti-Patterns

- `feat: add login page` — type prefixes belong to Conventional Commits, not Scoped Commits.
- `app: fix bug` — the scope is too broad and the description too vague to be useful.
- `update stuff` — no scope and no meaning.
- Bundling unrelated changes under one scope — split the commit instead.
- Generating a changelog from the commit log. Commit logs serve contributors; changelogs serve users. Keep them separate.
