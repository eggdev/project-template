# Clutch CLI

Installs this template into an existing project. The CLI checks the project,
switches its checkout to a new branch `template/install` from the default
branch, copies the files that [`clutch.files.yaml`](../../clutch.files.yaml)
names, and writes `.template-install/manifest.json`. The kickoff skill then works
through the manifest with the owner in their chosen agent interface. The
installer does not launch an agent by default.

The CLI copies from the last commit of this clone. Commit template changes
before you install them.

Agents find every repeatable command, `clutch` and `bun run pr`, by stage in
the [command index](../../.agents/skills/deliver/references/commands.md).

## Run it

From the root of the project that gets the template, run the CLI from your
clone of the template:

```sh
bun <template clone>/apps/cli/src/main.ts
```

The CLI refuses a folder that is not a git repository, a repository with
uncommitted changes, and a repository with no `package.json`.

After installation, open the project in any agent. Run `$kickoff` or
`/kickoff`, or ask the agent to follow `.agents/skills/kickoff/SKILL.md`. The
skill reads the manifest and runs the survey, the interview and the migration
in that session. To resume, open the project again. When the checkout is on
another branch, the CLI and the skill switch back to `template/install`. The
default branch does not change until you merge the install branch.

Use `--yes` to accept installation without a terminal confirmation, including
when an agent runs the installer. It does not approve product decisions.
To opt into the CLI-driven stages instead, pass `--agent claude` or
`--agent codex`. This requires that CLI on PATH and launches its terminal
interview. A saved provider preference never enables this mode implicitly.

## Files the project already has

Install reads `clutch.files.yaml`. A file that the project already has with
other content needs a decision before install changes anything:

- A `managed` file: keep the project copy, or take the Clutch copy.
- A `seed` file: keep, take, or merge. Merge writes both copies with conflict
  markers, and the manifest lists the file under `markers`.

In a terminal, install asks. Otherwise it lists the files and stops. Run it
again with `--keep <file>`, `--take <file>` or `--merge <file>` for each one.
Install also writes `.clutch/lineage.json`, so `clutch sync` can continue.

## Review tooling only

For an existing project, run from its Git root:

```sh
bun <clutch clone>/apps/cli/src/main.ts sync --only review --check --json
bun <clutch clone>/apps/cli/src/main.ts sync --only review
```

This syncs the entries that `clutch.files.yaml` tags `group: review`: the shared
delivery, audit, recap and verification-authoring skills, their Claude links and
the Python helpers. It does not install dependencies, and it never copies this
template's own verify. Use setup-verification afterward to author or maintain the
project's own verify. A scoped sync keeps the lineage of the other files, and it
leaves `clutch.yaml` alone.

## Issues

`clutch issues` reads the tracker in `.clutch/issues/`. Each issue is one
Markdown file with a frontmatter block. See `.clutch/README.md` for the fields.

The `clutch` script runs [`tools/clutch.ts`](../../tools/clutch.ts). In Clutch,
that runs this source. A project has no `apps/cli/`, so it runs the `clutch`
binary from the latest
[GitHub release](../../docs/contributing/setup/releases.md#the-clutch-binary),
which mise installs. `clutch --version` prints its release.

- `doctor` in the binary uses the capability registry built into it, the one
  of its release.
- `sync` and `init` in the binary read Clutch from a bare clone of the
  `template.repo` in `clutch.yaml`, kept in `$XDG_CACHE_HOME/clutch` or
  `~/.cache/clutch`. Each run fetches its tags first, so the latest release is
  the newest one on GitHub.
- `install` still runs from a Clutch clone, as [Run it](#run-it) shows. The
  binary says so.

```sh
mise exec -- bun run clutch issues
mise exec -- bun run clutch issues next --stack
mise exec -- bun run clutch issues set CL-003 review --pr <url>
mise exec -- bun run clutch issues new --phase P1 --title 'Add x' --range CL-118..CL-120
mise exec -- bun run clutch issues --write
mise exec -- bun run clutch issues --check
```

- `next` prints the first `todo` issue for an agent whose dependencies are
  done. With `--stack`, a dependency in review also counts, up to 3 stacked
  PRs. A `later` issue never comes next.
- `set` changes the frontmatter of one issue. It leaves `.clutch/TRACKER.md`
  alone: the release workflow regenerates it on the default branch, so a pull
  request never commits it.
- `new` fetches origin and writes a `todo` issue with the next free id. That
  id is one above the highest id in the phase's range, or in `--range`, across
  the working tree, each local branch and each `origin/*` branch. See
  `.clutch/README.md#commands`.
- `--write` renders `.clutch/TRACKER.md` in the format that `format-check`
  expects. The release workflow runs it on the default branch. Never edit that
  file by hand, and never commit it in a pull request.
- `--check` exits 1 when an issue file has a bad value. The message names the
  file and the field. `--check --fresh` also exits 2 when
  `.clutch/TRACKER.md` does not match the issue files.
- `--json` prints the issues and the errors as JSON.

## Checks

`clutch checks --changed [--base <ref>]` runs the project's
`tools/validate.ts --changed`: the validate targets of the affected Nx
projects, and the root checks. See
[only what changed](../../docs/contributing/setup/checks.md#only-what-changed).
It exits with the check's own code.

## Worktree

`clutch worktree` makes a separate checkout for one task, so several agents or
people work in one repository at once. It uses plain git worktrees. Each
checkout has its own `node_modules`, its own `.data` folder with its own
PGlite database, and its own dev server names.

```sh
mise exec -- bun run clutch worktree new cart-total --issue CL-201
mise exec -- bun run clutch worktree list
mise exec -- bun run clutch worktree rm cart-total
```

- `new <slug>` fetches the base, then makes the branch and its checkout in
  `<root>/<slug>`. The branch is `clutch/cl-NNN-<slug>` with `--issue`, or
  `clutch/<slug>` without it. `--base` defaults to the remote default branch,
  such as `origin/main`. A failed fetch only warns, so the command works
  offline.
- It copies each `worktree.copy` file that exists, such as `.env.local`, from
  the main checkout. Then it runs each `worktree.setup` command in the new
  checkout. With `--issue`, it sets the issue to `in_progress` there.
- It prints the path, the branch, and the dev server names from
  `bun run dev --check` when the project has a `dev` script.
- `list [--json]` shows each checkout with its branch, its dirty state, the
  issue in its branch name, and its PR when `gh` is signed in.
- The `worktree` block of `clutch.yaml` sets `root`, `copy` and `setup`.
  Without it, the checkouts go in `../<repo>.worktrees`, nothing is copied,
  and the setup is `mise trust --quiet` then `mise exec -- bun install`. mise
  refuses a config file in a new folder until it is trusted, and the install
  also installs the git hooks.
- `rm <slug> [--force] [--base REF]` refuses a checkout with uncommitted
  changes, or with commits that neither the base nor a remote branch holds.
  `--force` removes it anyway. It first stops that checkout's dev servers with
  `bun run dev --stop`, and only when a dev run there left
  `.data/dev-run.json`. Then it removes the checkout. It deletes the branch
  only when the branch is merged into the base.
- Run it from the main checkout or from a task checkout. Both use the main
  checkout's settings.
- The commands call a backend interface (`worktree/backend.ts`). Git is the
  only backend. Sprig is a possible later one (`.clutch/issues/CL-901.md`).

## Labels

`clutch labels` prints the labels of a change. `kind/<type>` comes from the
conventional type of `--title`. `area/<part>` comes from each changed file:
a file in a workspace package from the root `package.json` gets the package
folder's name, such as `area/cli` for `apps/cli/`. Any other file gets its
top folder without a leading dot, such as `area/docs` or `area/github`, and a
file at the root gets `area/root`.

```sh
mise exec -- bun run clutch labels --title "fix(cli): keep the value"
mise exec -- bun run clutch labels --base origin/main --head HEAD --title "docs: x" --json
```

It also gives `size/S` (up to 100 changed lines), `size/M` (300), `size/L`
(800) or `size/XL`. Lockfiles, snapshots, `.clutch/` and the globs in
`pr_size.exclude` do not count. Above `pr_size.warn` (300 by default) it
prints a warning. It never fails.

`--json` adds the color and description of each label, the label prefixes
that the command owns, and `one-way-door`, which the Labels workflow creates
so a person can add it. See [labels](../../docs/contributing/review.md#labels).

## Risk

`clutch risk` gives a change a risk tier from the paths it touches: `low`,
`medium`, `high` or `one-way-door`. The rules live in `.clutch/risk.yaml`, a
guardrail file.

```sh
mise exec -- bun run clutch risk
mise exec -- bun run clutch risk --base origin/main --head HEAD --json
```

- The change is every file that differs between the merge base of `--base`
  and `--head`. `--base` defaults to the remote default branch and `--head`
  to `HEAD`. A rename counts both paths.
- Each file gets the highest tier of the rules whose `paths` globs match it.
  A file that matches a rule's `except` glob does not match that rule. A file
  that no rule matches gets the `unmatched` tier. The change gets the highest
  tier of its files, and a change with no files is `low`.
- A rule with `guardrails: tools/guardrail-files.json` adds every pattern in
  that list to its paths, so the two cannot drift.
- The rules and the CLI come from the working tree. The
  [Risk workflow](../../.github/workflows/risk.yml) checks out the base
  branch first, so a pull request cannot lower its own tier. It labels the
  pull request `risk/<tier>` and removes any other `risk/` label.
- `--json` prints the tier and each file with its tier and the pattern that
  set it. Text output prints the tier and the files at that tier.

Clutch's own rules follow the [plan decisions](../../.clutch/PLAN.md#decisions):
Brendan's rule, held against the published risk policies of other teams.
`one-way-door` holds the automation and its gates (the guardrail list,
`.github/rulesets` and `.clutch/risk.yaml`), agent steering (`AGENTS.md`,
`CLAUDE.md` and the skills), auth (`packages/access`, `packages/identity` and
any `auth` folder) and migrations. It also holds a billing rule and an infra,
deploy and secrets rule, both empty until a project names its paths. Product
code in `apps`, `features`, `packages` and `tools`, including `packages/sync`,
and `bun.lock` are `medium`. Docs, tests, changesets and tracker files are
`low`. Any other path is `high`.

## clutch.yaml

Each repository that uses Clutch has a `clutch.yaml` at its root. It names the
Clutch repository and records the state of each capability. A repository without
the file has not adopted Clutch. A project never pins a Clutch commit: it
follows the latest Clutch release.

```yaml
schemaVersion: 1
project: shop # a short name for reports
template:
  repo: eggdev/clutch # the template repository
  mode: sync # sync: clutch sync manages the files. doctor: checks only.
capabilities: # keys are capability ids from the registry
  root_agents_md: adopted # the short form
  codeql_sast:
    status: waived # adopted, waived or n/a
    reason: Lands in CL-102. # required for waived and n/a
    issue: CL-102 # optional: the waiver ends when this issue is done
    until: 2027-01-31 # optional: after this date, the waiver fails the check
worktree: # optional
  root: ../shop.worktrees
  copy: [.env.local]
  setup: ['mise exec -- bun install']
automerge: # optional
  mode: dry-run # off (the default), dry-run or on
  step: low # bots (the default), low or medium: how far auto-merge reaches
  owner: eggdev # optional: the login whose reactions grade the dry-run verdicts
pr: # optional
  branchPrefix: clutch/cl- # the default: how bun run pr finds an agent's branch
sast: auto # optional: auto (the default), codeql or semgrep
pr_size: # optional
  warn: 300 # the default: clutch labels warns above it, and never fails
  exclude: [] # globs whose lines do not count, such as generated code
agentReview: # optional
  missingCredential: notice # notice (the default) or fail
```

`automerge.mode` tells the Auto-merge workflow what to do, and `automerge.step`
how far it reaches: bot PRs, then low-risk agent PRs, then medium-risk ones. See
[auto-merge](../../.agents/skills/deliver/references/pull-requests.md#auto-merge).

`agentReview.missingCredential` tells `agent-review.yml` what to do without an
Anthropic credential: pass with a notice, or fail. Set `fail` once
`agent-review` is a required check. See [review](../../docs/contributing/review.md).

`sast` picks the static analysis engine that `.github/workflows/sast.yml` runs.
`auto` runs CodeQL where code scanning takes results and Semgrep elsewhere.
`codeql` fails the check where code scanning takes no results. `semgrep` runs
Semgrep even on a public repository. See
[CodeQL / SAST](../../docs/contributing/capabilities/codeql-sast.md).

The loader rejects unknown keys. Each error names its YAML path, such as
`template.mode` or `capabilities.codeql_sast.reason`. An older `clutch.yaml`
has `template.commit`. The loader accepts it and reads nothing from it, and
the next sync removes it. `clutch.yaml` is a
guardrail file, so a person reviews each change to it.

## Init

`clutch init` adopts Clutch in a repository that does not have it yet. It
writes `clutch.yaml`, the tracker in `.clutch/` and the doctor baseline. It
never commits.

```sh
mise exec -- bun run clutch init --root ../shop --yes
mise exec -- bun run clutch init --root ../shop --adopt --yes
mise exec -- bun run clutch init --root ../bar-savvy-web --mode doctor --yes
```

- Each capability that the repository has is adopted. Each core gap gets the
  waiver "Decide during adoption." Replace each one with a reason and an issue.
- `--adopt` is for a repository that already holds Clutch files. A managed file
  that matches an earlier Clutch version goes in `.clutch/lineage.json`, so
  sync may update it. An edited file stays a keep-or-take decision.
- `--mode doctor` is for a repository that Clutch checks but never syncs. It
  writes no lineage.
- `--adopt` compares the files with the latest Clutch release, the newest
  `vX.Y.Z` tag in the clone.
- In `sync` mode, init also writes the seeds that the managed tooling reads:
  `.clutch/risk.yaml` for the Risk workflow and `clutch risk`, and
  `.changeset/README.md`. Install writes every seed, and sync never writes
  one, so init fills the gap. It keeps a copy that the project already has.
- Init refuses a repository that already has `clutch.yaml`.

### Start a new project from Clutch

Run these steps in order, from the project's root:

1. Install the formatter: `bun add --dev oxfmt`. Init and sync format the
   files they write, and they fail without it.
2. Run `clutch init --yes`, then commit. Sync refuses uncommitted changes.
3. Run `clutch sync`. It copies the managed files and merges `package.json`,
   which gains the `pr`, `clutch` and `validate` scripts.
4. Run `bun install`, then commit.

`tools/release/fresh-project.test.ts` runs these steps with the release binary.

## Sync

`clutch sync` moves a project to the latest Clutch release. `clutch.files.yaml` in Clutch
names the files and gives each one a rule. The longest matching path decides.

| Rule      | What sync does                                                       |
| --------- | -------------------------------------------------------------------- |
| `managed` | Replaces the file. A file that the project edited needs a decision.  |
| `merge`   | Merges the project's copy with Clutch's copy.                        |
| `seed`    | Nothing. Install writes it once, and the project owns it after that. |

```sh
mise exec -- bun run clutch sync --root ../shop --check
mise exec -- bun run clutch sync --root ../shop
mise exec -- bun run clutch sync --root ../shop --to v0.2.0
```

- Each merge to Clutch's `main` is a release with a `vX.Y.Z` tag. Without
  `--to`, sync uses the newest tag. The release binary fetches the tags on each
  run. A clone uses its own tags, so run `git pull --tags` in it first. Sync
  prints the release it used.
- `--to <tag or commit>` syncs to one revision once, such as an unreleased
  commit for a test.
- `.clutch/lineage.json` records the release of the last sync in `release`.
- `.clutch/lineage.json` records the hash of each managed file at the last
  sync. A project with only the older `.review/tooling.json` starts from it, and
  sync removes that file once the lineage holds its record.
- `known` in `clutch.files.yaml` holds the hashes of older Clutch copies. A
  project file that matches one is unchanged, so sync may replace it.
- `--check` changes nothing. It exits 0 when the project is up to date, 2 when a
  sync would change files or a file needs a decision, and 1 on an error.
  Without `--to`, exit 2 means the project is behind the latest release.
- A sync never commits. Commit the result on a branch, and open a PR.
- A managed file that the project edited needs a decision, and nothing changes
  until each one has an answer. In a terminal, sync asks: keep the project
  copy, take the Clutch copy, or show the difference first.
- Without a terminal, or with `--json`, sync lists those files and exits 2. An
  agent asks the owner, then runs sync again with `--keep <file>` or
  `--take <file>` for each one. An agent never decides for the owner.
- In a merge file, each value that the project and Clutch set differently is a
  decision too, named by file and key path, such as
  `package.json#scripts.validate`. Keep holds the project value, and take lets
  Clutch's value win. Install still lets Clutch's value win on a new project.
- A kept file stays quiet until Clutch changes it again. `.clutch/lineage.json`
  records the Clutch copy that the project declined.

## Use Clutch in another repository

A repository with `clutch.yaml` can run the Clutch checks in its own CI with
one job. The workflow checks out the latest release of the Clutch repository
that `clutch.yaml` names, runs `clutch doctor --check`, and runs
`clutch sync --check` against that release in `sync` mode. So the job fails
when the project is behind the latest release:

```yaml
jobs:
  clutch:
    uses: eggdev/clutch/.github/workflows/clutch-doctor.yml@<sha> # main
```

Pin a commit SHA from `main`. `check-workflows` rejects a branch or tag ref.
`gh api repos/eggdev/clutch/commits/main --jq .sha` prints the newest one. The
workflow still checks against the latest Clutch release, so an older pin only
holds the workflow steps back.

Pass `with: { root: <folder> }` when `clutch.yaml` is not at the repository
root.

## Doctor

`clutch doctor` shows each capability that a repository has, next to what its
`clutch.yaml` declares. It reads the registry of the Clutch checkout that runs
it. `--json` names the release of the project's last sync in
`templateRelease`.

```sh
mise exec -- bun run clutch doctor
mise exec -- bun run clutch doctor --root ../shop --json
mise exec -- bun run clutch doctor --phase P1
```

- Each line shows the detected state, the declared state and the evidence or
  the waiver reason. A summary line follows.
- A capability is present when every detect rule passes, and partial when
  some pass and one fails. It is unknown when the rules that did not pass are
  all unknown, such as remote rules without `--remote`.
- A repository without `clutch.yaml` reports each capability as undeclared.
- After the summary, a line names the SAST engine that `sast` in
  `clutch.yaml` runs, such as `SAST: auto -> codeql (public repository)`.
  Without `--remote`, doctor cannot tell CodeQL from Semgrep for `auto` and
  `codeql`, and prints `?`.
- With `--remote`, the last lines compare each file in `.github/rulesets/`
  with GitHub, as `clutch ruleset` does.
- `--category` and `--phase` narrow the report.
- `--remote` reads GitHub settings for the `remote:` rules: branch rules and
  protection, secret scanning, push protection, the merge queue, auto-merge,
  CodeQL default setup, Actions secret names and recent review bot comments.
  It sends only `gh api` GET requests, for the origin repository or
  `--repo OWNER/NAME`. A setting that the token cannot read is
  unknown, and an unknown result never fails `--check`.
- It exits 0 after a report, and 1 when the registry or `clutch.yaml` is bad.

`clutch doctor --check` is the gate. It fails, and exits 1, in these cases:

- An adopted capability is not present.
- A core capability is not present, and `clutch.yaml` has no waiver or `n/a`
  for it. An extra capability only gets a warning.
- A waiver passed its `until` date, or its `issue` is done in `.clutch/issues/`.
- A capability dropped below `.clutch/doctor-baseline.json`.
- With `--remote`, `sast` is `codeql` on a private repository without GitHub
  Code Security, so `sast.yml` fails.
- With `--remote`, a ruleset on GitHub differs from its file in
  `.github/rulesets/`, or does not exist. See [Ruleset](#ruleset).

A remote rule that is unknown never fails the gate. When a capability's files
pass and only its remote rules are left, it is unknown without `--remote`, so
config alone never reads as present. When a capability rose
above the baseline, the gate exits 2. Then run
`mise exec -- bun run clutch doctor --write-baseline` to raise the baseline.
The baseline only moves up. A lower value needs `--allow-downgrade` and the
owner's review, because the baseline is a guardrail file.

## Ruleset

`clutch ruleset` compares each file in `.github/rulesets/` with the ruleset of
the same name on GitHub, for the origin repository or `--repo OWNER/NAME`.
`--apply` creates a ruleset that GitHub does not have, or updates the one with
the same name with PUT, then compares again. Run it after each change to a
ruleset file.

```sh
mise exec -- bun run clutch ruleset
mise exec -- bun run clutch ruleset --apply
```

- Only the keys that the file names count, because GitHub adds defaults. A
  list, such as the required checks, must hold the same items in any order.
- A bypass actor whose `actor_id` is `vars.NAME` gets the value of the
  repository variable `NAME`. The release bot uses `vars.CLUTCH_APP_ID`, so one
  file fits each project. When the variable is not set, the actor is left out
  with a note.
- It exits 0 when every ruleset matches, 2 when one differs or is missing, and
  1 when `gh` fails. Applying needs a token with admin rights on the repository.

## Metrics

`clutch metrics` reports how pull requests flow through a repository over a
window: merges per day, the share merged with no human action, the hours from
open to merge, main-red minutes, reverts, the agent share from
`Co-authored-by` trailers and agent branches, PR size, the merges with no
human action by auto-merge step, CI run times, the issues done and the
owner's agreement with the auto-merge dry run. It sends only
`gh api` GET requests, for the origin repository or `--repo OWNER/NAME`, so it
works from a clone and from the release binary in any project.

```sh
mise exec -- bun run clutch metrics
mise exec -- bun run clutch metrics --since 30d --json
mise exec -- bun run clutch metrics --verdicts
```

- `--since` takes a number of days, such as `14d`, the default.
- `--json` prints the report for a digest. A section that GitHub does not
  answer is null, and `unavailable` names the reason.
- The issues done come from `.clutch/issues` in the checkout, so `--repo` for
  another repository reports them as unavailable. The same goes for
  `pr.branchPrefix` and `pr_size.exclude`: another repository gets the
  defaults.
- `--verdicts` lists the auto-merge dry-run verdicts that the owner has not
  graded, with the reasons, the link and the agreement streak. `--owner LOGIN`
  names the owner; it defaults to `automerge.owner` in `clutch.yaml`, then the
  CODEOWNERS default. See
  [grade the verdicts](../../.agents/skills/deliver/references/pull-requests.md#grade-the-verdicts).
- It exits 0 after a report, and 1 when `gh` fails for the merged pull requests.

See [factory telemetry](../../docs/contributing/capabilities/factory-observability.md)
for what each number counts.

## Capability registry

`docs/contributing/capabilities/registry.yaml` lists each capability that a
repository can adopt, and the rules that detect it. `clutch doctor` reads it.

Each rule checks the files that git tracks. An untracked file never counts.

| Rule                                  | Passes when                                                               |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `file: <glob>`                        | A tracked file matches. `min` raises the count. `exclude` skips globs.    |
| `grep: { files, pattern }`            | A matching tracked file contains the regex.                               |
| `script: <name>`                      | The root `package.json` has the script.                                   |
| `target: <name>`                      | A `package.json` or `project.json` defines the Nx target.                 |
| `workflow: { on, uses, run, pinned }` | One workflow file matches every given field.                              |
| `yaml: { file, path }`                | The dotted path holds a value in the YAML or JSON file that is not empty. |
| `remote: <probe>`                     | The GitHub setting holds. It is unknown without `--remote`.               |
| `any` and `all`                       | They combine rules. An unknown rule inside `any` is skipped.              |

A capability is present when every `detect` rule passes. It is partial when
some pass and one fails, or when only `partial_if` rules pass. It is missing
when none pass. It is unknown when the rules that did not pass are all
unknown, such as remote rules without `--remote`. The registry is a guardrail
file, so a person reviews each change to it.

## Test it

```sh
mise exec -- bun nx run-many -t test typecheck lint -p @repo/cli
```
