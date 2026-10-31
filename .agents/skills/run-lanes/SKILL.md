---
name: run-lanes
description: Coordinate several agent lanes that deliver tracker issues in parallel, each in its own worktree and branch. Use when the owner asks to run work in parallel lanes, to split a phase across agents, or to coordinate other agent sessions. Do not use it for a single task; use deliver.
---

# Run parallel lanes

A coordinator splits a set of `.clutch/issues` across lanes. Each lane is an
agent session in its own git worktree. It delivers its issues one PR at a time
and merges them itself. The coordinator steers the lanes and relays the owner's
decisions. It writes no product code of its own.

Lanes run in any host that gives each agent a worktree and lets the coordinator
send it messages. T3 Code threads are one way: one thread for each lane, with a
worktree for each thread. Separate terminal sessions in separate worktrees work
too.

## 1. Split the work by file ownership

Lanes collide when two branches change the same file. Split by the files that
each issue changes, not by topic.

1. List the issues to run, with `mise exec -- bun run clutch issues`. Read the
   steps of each one.
2. Group the issues so that no two lanes own the same source file. Put issues
   that depend on each other in one lane, in dependency order.
3. Name what each lane owns, and what it must not touch. A lane that needs a
   file another lane owns asks the coordinator first.
4. Three lanes is a good start. More lanes mean more rebases on `main`.

Lanes never commit `.clutch/TRACKER.md`: the release regenerates it on `main`
with the changelog. Each PR commits only its own issue files, so the tracker
never conflicts between lanes.

## 2. Reserve issue ids

Parallel branches cannot see each other's new issue files. Two lanes that pick
the next id by hand can pick the same one. Give each lane its own block, and
have it file every new issue with that block:

```sh
mise exec -- bun run clutch issues new --phase P1 --title 'Add x' --range CL-310..CL-312
```

`clutch issues new` also counts the issue files on every `origin/*` branch.
Run `mise exec -- bun run clutch issues --help` for its options.

## 3. Write each brief

The brief is the only context a lane gets. Use this shape, and fill every part:

```markdown
You are lane <X> of <N> parallel lanes working on <phase> of the plan in
<owner/repo>. A coordinator session launched you on behalf of <owner>. You are
in your own git worktree. Do the work yourself.

## Your issues, in order
1. **CL-NNN** <title> (`.clutch/issues/CL-NNN.md`, read its notes).

<Why these issues matter now, such as the critical path.>

## Read first
`AGENTS.md`, `.clutch/README.md`, <the plan, if the project keeps one>,
`.agents/skills/deliver/references/pull-requests.md`, `docs/contributing/review.md`.

## Rules (from <owner>, <date>)
- One issue, one branch `clutch/cl-NNN-<slug>`, one PR opened with
  `mise exec -- bun run pr open --title "<conventional title> (CL-NNN)" --body-file <file>`.
  Fill every section of the PR template. Conventional commits. Never `--no-verify`.
- Run `mise exec -- bun run validate` before each push.
- When the PR is green and ready, its last commit runs
  `bun run pr ready CL-NNN <number>`, which commits only the issue file.
- Merge rules: see "Merge" below.
- File new issues with `clutch issues new --range <your block>`.
- Never commit `.clutch/TRACKER.md`. The release writes it on `main`.
- <Known flakes, and what to do: rerun a failed job once before you debug.>

## Lane boundaries
- Lane <Y> owns <issues and files>. Lane <Z> owns <issues and files>.
- <Cross-lane facts, such as a check that another lane is adding.>

## Design notes from the coordinator
- <Decisions the issue leaves open, with the default to take.>
- A decision that is the owner's goes at the end of your reply as a question.
  Do not stop the lane for a minor choice: pick a sensible default, flag it in
  the PR, and continue.

## When you finish
Reply with each PR URL, its merge commit, anything unverified, and open
questions. End with `PR <url>, head <sha>, checks and reviews <state>` for each PR.
```

Keep the rules the same in every brief. Change only the issues, the boundaries
and the design notes.

## 4. Delegate the merge

A lane merges its own PR with `mise exec -- bun run pr merge <number>` when all
of these hold:

- Every required check passed, and agent review passed with 0 blocking
  findings.
- The last commit marks the issue `done`.
- `main` has not moved since the last green run, or the lane ran the train
  steps below.
- The coordinator has not put the PR on hold.

Agent review often blocks on docs that did not move with the behavior. The lane
fixes the docs it names and pushes again. A note is not a block. The lane
answers a note it disagrees with in the thread.

## 5. Merge in a train

Each PR can pass CI alone and still break `main` together with another one.
For example, one lane adds a workflow while another adds a workflow lint. Each
PR is green. Merged minutes apart, the lint fails on the new workflow, and
`main` is red for every lane.

Before a lane merges, it checks whether `main` moved since its last green run:

1. Run `git fetch origin` and compare the PR's base with `origin/main`.
2. When `main` moved, run `mise exec -- bun run pr sync` if the project's `pr`
   tool has it. Otherwise rebase on `origin/main`, run `validate`, and push with
   `pr open --force`.
3. Wait for the new run to pass, then merge.

When `main` turns red anyway, the coordinator names one lane to fix it, and the
other lanes stop merging until it is green. Record each such incident in the
issue that decides on a merge queue. Incidents are the evidence for one.

## 6. Steer the lanes

- Answer a lane's question in one message, with the decision and its reason.
- Send new work as a follow-up brief with the same rules. Name the issue ids,
  and say what the new brief replaces.
- To hold a PR, say so plainly: "Open the PR, but do not merge it." Lift the
  hold in a later message.
- When two lanes need the same file, give it to one lane, and stack or delay
  the other.
- Do not poll a lane. Each lane reports when it finishes or when it is blocked.

## 7. Relay the owner's questions

Lanes put the owner's decisions at the end of each reply. Collect them, drop
the ones that a lane already settled with a default, and ask the owner once.
Relay each answer to the lane that asked, in the owner's own words, with the
date. A decision that changes the plan also goes into the project's plan or
decision records, in the PR that acts on it.
