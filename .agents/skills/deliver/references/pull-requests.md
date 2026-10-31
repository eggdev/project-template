# Pull requests and stacks

Every pull request in a project follows these rules. The commands below do the
GitHub steps. Use these commands. Do not hand-write `gh` calls or polling
loops, so each session and each project does the same thing. The
[command index](./commands.md) lists every command.

## Set up once per machine

```sh
mise install
mise exec -- bun run pr doctor --fix
```

`mise.toml` pins the GitHub CLI version. `doctor` checks that version, the
sign-in and the pinned `github/gh-stack` extension. `--fix` installs the
extension at the pinned version. Run each command below through `mise exec`,
so the pinned `gh` runs.

## Open a pull request

```sh
mise exec -- bun run pr open --title "<sentence>" --body-file <file>
```

- Open each PR ready for review. Never open a draft.
- Write each commit and the PR title as a Conventional Commit:
  `type(scope)!: subject`, such as `fix(cli): keep the project value`. The
  `commit-msg` hook checks each commit, and `open` checks the title. `fix` is a
  patch release, `feat` is a minor one, and `!` marks a breaking change.
- Each PR carries a changeset in `.changeset/`. `open` writes one from the
  title when the branch has none. See
  [releases](../../../../docs/contributing/setup/releases.md).
- Fill every section of `.github/pull_request_template.md` in the body file.
- `open` pushes the branch first, so the pre-push checks run.
- When the branch already has an open PR, `open` replaces its body.
- After you rebase your own branch, run `open` again with `--force`. It pushes
  with `--force-with-lease`, which refuses when someone else pushed to the branch.
- To change only the body, run `bun run pr body <number> <file>`.
- `open` asks the release bot to open a new PR. See
  [who opens the pull request](#who-opens-the-pull-request).
- After the first green push, run `bun run pr ready <id> <number>`. The merge
  makes `done` true. A PR that waits on a lower PR in a stack uses `review`
  until it is ready to merge.

### Who opens the pull request

GitHub never lets a PR's author approve it. So that the owner can approve an
agent's PR, the release bot opens it, and the owner stays the author of each
commit:

1. The agent commits as the owner, with the owner's git identity and a
   `Co-Authored-By` trailer that names the agent. The contribution graph
   credits the owner.
2. `open` pushes the branch, then runs
   `gh workflow run open-pr.yml --ref <default branch>` with the head, the base
   and the title. That workflow mints the bot token in the `release`
   environment, so the key stays limited to the default branch. It never checks
   out or runs code from the branch. It only calls the pull request API.
3. `open` waits up to 3 minutes for the PR, then sets the body as the owner.

When the repository has no `CLUTCH_APP_ID` variable, or the default branch has
no `open-pr.yml`, or the bot opens no PR in time, `open` opens the PR as the
user. See [the release bot](../../../../docs/contributing/setup/releases.md#the-release-bot).

### Approval

`.github/CODEOWNERS` lists the `one-way-door` paths of `.clutch/risk.yaml`, and
the main ruleset requires a code owner's approval. So GitHub requires the
owner's approval on a PR that changes one of those paths, and on no other PR.
`tools/codeowners.ts` generates the file, and `check-agent-hooks` fails when it
drifts. After a change to the one-way-door tier, run
`mise exec -- bun tools/codeowners.ts --write`.

## Follow a pull request to green

Between open and merge, use the [babysit-pr](../../babysit-pr/SKILL.md) skill.
It decides what to do with each failure, on top of the commands below.

| Command                                 | When to use it                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `bun run pr status <number> [--json]`   | Before each decision. It shows the required checks, the agent review's blocking count, the dry-run verdict, the review decision and the mergeable state at the head commit. A PR that a rule still blocks, such as one waiting on a code-owner review, is not ready. |
| `bun run pr wait <number> [--timeout 30m]` | After a push. It waits until no check is pending and GitHub shows the commit that the checkout has, then prints the status. It exits 0 when the PR is ready, 1 when it is not, and 2 at the timeout. |
| `bun run pr failures <number>`          | When a check failed. It prints the failed step of each job, and the output of each failed Nx task, without ANSI codes. |
| `bun run pr sync <number, branch or id>` | When GitHub reports the PR as conflicting. It rebases on the PR's base, takes the base's copy of `.clutch/TRACKER.md` if an older branch still committed it, runs `validate` and pushes with a lease. It stops on any other conflict. For a stacked PR whose base was rewritten or merged, it replays only the PR's own commits. After a rebase that you finished by hand, it rebases as usual. |
| `bun run pr ready <id> <number>`        | When the PR is green and ready to merge. It sets the issue to `done` with the PR link, regenerates the tracker, commits `chore(tracker): mark <id> done` and pushes. |

Each command reads the repository from the `origin` remote. `sync` takes an
issue id, such as `CL-117`, and finds the branch with the prefix that
`pr.branchPrefix` in `clutch.yaml` names. The default is `clutch/cl-`. `sync`
and `ready` change the tracker through `tools/clutch.ts`, so they run the
release binary in a project.

## Stack a pull request on another one

When the work builds on a branch whose PR is still open, the PRs form a stack.
GitHub stacks are linear. Each branch sits on the branch below it, and each PR
uses that branch as its base.

1. Find the top branch of the open stack.
2. Make the new branch from that top branch, even when the new work does not
   depend on every PR below it.
3. Run `open` with `--base <top branch>`. It adds the new PR to the top of the
   stack.

Never give two open PRs the same base branch, except the default branch. Two PRs
on one base cannot form a linear stack, and they can conflict in generated
files. To join such PRs, rebase the second branch onto the first one. Then run
`open` for it again with the new base.

Keep a stack to three open PRs or fewer. At three, ask the owner to merge the
lower PRs before you add another one.

## Merge

Merge only when the owner says so. The one exception is a PR that the Auto-merge
workflow queues under `automerge.mode: on` in `clutch.yaml`, within the reach of
`automerge.step`. At `bots`, only Renovate and gardening PRs merge this way. See
[Auto-merge](#auto-merge).

```sh
mise exec -- bun run pr merge <number>
```

`merge` refuses while GitHub reports that the PR needs a review
(`REVIEW_REQUIRED`) or has changes requested, and it names the reviewer. A
ruleset's code owner review leaves that decision empty, so `merge` also
refuses a PR that GitHub reports as blocked while a review is still requested. The
owner's admin login can bypass the ruleset, so this keeps an agent that runs
`merge` with the owner's login from merging past the approval.

For a PR in a stack, `merge` merges every PR from the bottom up to that one,
with merge commits. When one merge fails, none of them merge. For a PR that is
not in a stack, it merges that PR with a merge commit. GitHub can still count a
PR as stacked after the PRs below it merged. When GitHub refuses the plain
merge for that reason, `merge` merges through the stack.

Each merge to the default branch is a release. `merge` then waits for the run of
`release.yml` on the merge commit, up to `--timeout` (15 minutes by default). It
prints the released version, or the failed run, and exits 1 when the release
fails.

The default branch takes no direct pushes, so a task cannot become `done`
after its merge. When the PR is green and ready to merge, its last commit sets
the task to `done` with its PR link, and the merge makes that true. When a PR
closes without a merge, set its task back to `todo` in the next branch.

## Auto-merge

The Auto-merge workflow (`.github/workflows/auto-merge.yml`) judges agent and
bot PRs. An agent PR's head branch starts with `clutch/cl-`. Only an agent opens
such a branch. The release bot opens most agent PRs, and the user opens the
rest, so the author cannot tell an agent from a person. A bot PR's branch starts with `renovate/` or
`gardening/`, and its author is a bot.

`automerge.step` in `clutch.yaml` sets how far auto-merge reaches. Each step
takes the PRs of the steps before it:

| Step     | Takes                                                                                         |
| -------- | --------------------------------------------------------------------------------------------- |
| `bots`   | Bot PRs that pass the bot rule.                                                               |
| `low`    | Also agent PRs that `clutch risk` gives `low`.                                                |
| `medium` | Also agent PRs that it gives `medium`. Agent review passed, so they have 0 blocking findings. |

The bot rule:

- A Renovate PR may change only versions: `package.json` dependency versions,
  pinned action SHAs in workflows, tool versions in `mise.toml`, lockfiles and
  changesets. Renovate already waits out the 3-day release age.
- A gardening PR's `clutch risk` tier must be `low`.

At each step, the PR also needs all of these:

- It is open, not a draft, and its base is the default branch. A stacked PR
  waits.
- The latest run of each required check of the default branch, and of
  `agent-review`, succeeded on its head commit.
- No required check is red on the default branch's latest commit. A red
  `main` stops every auto-merge until it is green again.

The workflow runs when CI or agent review completes, and it runs the default
branch's rules. It skips a run whose branch lives in a fork, because that run
gets this repository's token. `automerge.mode` decides what it does:

- `off` prints the verdict in the job summary.
- `dry-run` comments its verdict at the step, once for each head commit of an
  open, ready agent PR: "would auto-merge", or "would not auto-merge" with the
  reasons. It waits until every required check has finished. The comment asks
  the owner to react 👍 when they agree and 👎 when they do not. `clutch
  metrics` counts those reactions as `dryRunAgreement`.
- `on` runs `gh pr merge --auto --merge` with the release bot token, for each
  PR that may merge at the step, and comments that the merge is queued. A
  separate `merge` job does that in the `release` environment, which holds the
  bot's key and admits only the default branch. So only a run that CI or agent
  review completes merges, and the merge is pinned to the judged head commit. GitHub
  merges it with a merge commit once the required checks pass. A merge made with
  the default token starts no workflow, so the bot's token keeps the release
  and CI running on `main`. Each agent PR also gets the dry-run verdict for the
  next step, so the owner can grade it before that step turns on.

To stop one queued merge, run `gh pr merge --disable-auto <number>`. To stop
all of them, set `automerge.mode` to `dry-run`.

### Grade the verdicts

The owner grades verdicts after the fact, in one place. Each week the gardening
workflow opens or updates the issue "Auto-merge calibration: week of <date>".
`gh workflow run grade-verdicts.yml` opens or updates it now.
It lists each verdict that the owner has not graded, with its reasons and a
link. In that issue, the owner comments:

- `agree with all` or `/agree all`: a 👍 on every listed verdict.
- `/disagree #<pr>`: a 👎 on that PR's verdict. It stays on the list with a note.

The Grade verdicts workflow (`.github/workflows/grade-verdicts.yml`) reads only
the owner's comments. The owner is `automerge.owner` in `clutch.yaml`, else the
default owner in CODEOWNERS. The release bot adds the reactions. The workflow
then replies "Graded on the owner's instruction" and names the bot's login,
which it reads from the app token. `clutch metrics` counts the owner's
reactions, and those of each bot that a bot's reply names. It ignores anyone
else's. `clutch metrics --verdicts` lists the ungraded verdicts
and the agreement streak.
