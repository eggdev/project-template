# Commands

Each step of delivery has one repeatable command. Use it instead of a raw `gh`
or `git` sequence, so every session does the same thing. Run each one through
`mise exec --`, so the pinned tools run. `--help` on any `clutch` command prints
its options, and so does `bun run pr --help`.

## Start work

| Command                                                                           | Use it when                                         | It replaces                                     |
| --------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| `bun run clutch issues next [--stack]`                                            | You need the next unblocked issue.                  | Reading `TRACKER.md` by eye.                    |
| `bun run clutch issues new --phase <P> --title <title> [--range CL-NNN..CL-NNN]` | You file a new issue, or a lane has a reserved range. | Picking the next id by hand.                    |
| `bun run clutch issues set <id> <status> [--pr <url>]`                            | An issue starts, waits or goes to review.           | Editing frontmatter by hand.                    |
| `bun run clutch issues --write`                                                   | You want to read the table locally. Do not commit it: the release writes it on `main`. | Reading every issue file.                       |
| `bun run clutch worktree new <slug> [--issue <id>]`                               | You start a task beside other work in this repository. | `git worktree add`, copying env files and `bun install` by hand. |
| `bun run clutch worktree list [--json]`                                           | You want each checkout's branch, issue, PR and dirty state. | `git worktree list` and matching branches to PRs by hand. |
| `bun run clutch worktree rm <slug> [--force]`                                     | A task's checkout is done, or abandoned.            | Stopping its servers and `git worktree remove` by hand. |

## Check

| Command                                  | Use it when                                    | It replaces                                  |
| ---------------------------------------- | ---------------------------------------------- | -------------------------------------------- |
| `bun run validate`                       | Before each push and before you say "done".    | Running checks one by one.                   |
| `bun run validate --changed`             | While you work, to check only what the change affects. | Waiting for the full `validate` after each edit. |
| `bun run clutch doctor [--remote]`       | You want each capability's state, or GitHub's. | Reading workflows and settings by hand.      |
| `bun run clutch doctor --check`          | You changed `clutch.yaml` or a capability.     | Guessing whether a waiver still holds.       |
| `bun run clutch risk [--base <ref>]`     | You want a change's risk tier before a PR.     | Judging the tier from the file list.         |
| `bun run clutch labels [--title <title>]` | You want a change's kind, area and size labels, or its size warning, before a PR. | Choosing `kind/`, `area/` and `size/` labels by hand. |
| `bun run clutch ruleset [--apply]`       | A file in `.github/rulesets/` changed, or you want to know if GitHub matches it. | `gh api` POST or PUT on the rulesets endpoint. |
| `bun tools/codeowners.ts --write` | The `one-way-door` tier in `.clutch/risk.yaml` changed. | Editing `.github/CODEOWNERS` by hand. |

`validate` prints the output of each failed task inline, so read it there.

## The pull request loop

See [pull requests](./pull-requests.md) for the rules behind each one. The
[babysit-pr](../../babysit-pr/SKILL.md) skill strings them into rounds that
take a PR to green.

| Command                                                  | Use it when                                          | It replaces                                     |
| -------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| `bun run pr doctor [--fix]`                              | Once on each machine.                                | Installing `gh` and its extensions by hand.     |
| `bun run pr open --title <title> --body-file <file>`     | You open a PR, or push to one. Add `--force` after a rebase. | `git push` and `gh pr create`.                  |
| `bun run pr body <number> <file>`                        | Only the PR description changes.                     | `gh pr edit --body-file`.                       |
| `bun run pr status <number>`                             | Before each decision about the PR.                   | `gh pr checks` and reading review comments.     |
| `bun run pr wait <number>`                               | After a push, to wait for the checks.                | A `gh pr checks --watch` or `sleep` loop.       |
| `bun run pr failures <number>`                           | A check failed.                                      | Digging in `gh run view --log`.                 |
| `bun run pr sync <number>`                               | The base moved, or the tracker conflicts.            | A manual rebase, tracker fix, validate and push. |
| `bun run pr ready <id> <number>`                         | The PR is green and ready to merge.                  | `clutch issues set ... done`, commit and push.  |
| `bun run pr merge <number>`                              | The merge rules hold.                                | `gh pr merge` and `gh stack merge`.             |

## Measure

| Command                                       | Use it when                                         | It replaces                          |
| --------------------------------------------- | --------------------------------------------------- | ------------------------------------ |
| `bun run clutch metrics [--since 30d] [--json]` | You want flow numbers or the dry-run agreement streak. | Counting PRs and reactions by hand. |
| `bun run clutch metrics --verdicts [--json]` | You want the dry-run verdicts the owner has not graded yet, with reasons and links. | Searching PR comments for verdicts. |
| `gh workflow run grade-verdicts.yml` | You want this week's calibration issue now. The gardening workflow opens it each week. | Collecting verdicts into an issue by hand. |

The owner grades every listed verdict in the calibration issue with one
comment: `agree with all` or `/agree all`, or `/disagree #<pr>` for one PR.
Do not add 👍 reactions for the owner by hand.

## Release

Each merge to the default branch is a release. `pr open` writes the
changeset from the PR title, and the release workflow does the rest. See
[releases](../../../../docs/contributing/setup/releases.md).

| Command                                | Use it when                                  | It replaces                          |
| -------------------------------------- | -------------------------------------------- | ------------------------------------ |
| `bun run clutch sync --check`          | You want to know if a project is behind.     | Comparing files with the template.   |
| `bun run clutch sync`                  | You move a project to the latest release.    | Copying template files by hand.      |
| The `revert` label on a merged PR      | A merged PR must come out.                   | A hand-made `git revert` and PR.     |

## Do not hand-roll

- A loop of `gh pr checks` or `sleep`. Use `pr wait`.
- Digging in `gh run view --log`. Use `pr failures`.
- `gh pr merge` or `gh stack merge`. Use `pr merge`, which handles stacks.
- Committing `TRACKER.md` in a PR. The release writes it on `main`.
- `gh api` writes to a ruleset. Use `clutch ruleset --apply`.
- Guessing the next issue id. Use `clutch issues new`.

The agent shell hook prints a hint when a session runs one of these `gh`
commands. It never blocks the command.
