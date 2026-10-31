# Checks

Run every command from the repository root through [Nx](./nx.md).

## Validate

```sh
mise exec -- bun run validate
```

Run it before you say a change is done. CI runs it on each push to `main`, and
`validate --changed` on each PR. See [CI](#ci).
Nx caches results, so a second run with no changes takes seconds. A failure
names its target and prints that task's full output. A passing or cached task
prints one line.

[`tools/validate.ts`](../../../tools/validate.ts) holds the target list and
runs Nx for `validate`, `check` (`--quick`) and the pre-push hook. It passes
`--outputStyle=static-failures-only`. Without it, Nx 23 picks the `summary`
style when an AI agent runs it. That style prints only the path of each failing
task's log under `~/.nx`. Clutch syncs `tools/`, so a project gets a change to
the list or the flags without a decision on its `package.json` scripts.

### Only what changed

```sh
mise exec -- bun run validate --changed
mise exec -- bun run clutch checks --changed --base origin/main
```

`validate --changed` checks only what the change affects. It is fast enough
to run while you work. `validate` stays the gate before you say "done".

- The base comes from [`tools/check-base.ts`](../../../tools/check-base.ts):
  `CHECK_BASE` when it is set, or else the merge base with `origin/HEAD` or
  `origin/main`. The pre-push hook and the base checks use the same helper.
- The change is every file that differs from the base: commits, edits and
  untracked files.
- A docs-only change runs the root `checks`. Any other change runs the
  validate targets of the affected Nx projects, then the root `checks`, which
  read the whole tree.
- With no base, such as an all-zero `CHECK_BASE`, everything runs.
- It prints its time and warns above the budget in `changedBudgetSeconds`.
- `clutch checks --changed` runs the same mode from the release binary, through
  the project's `tools/validate.ts`.

## Git hooks

`bun install` runs the root `prepare` script,
[`tools/hooks/install.ts`](../../../tools/hooks/install.ts). It points Git at
the hooks in `.githooks/`. Each hook runs through `mise`, so it uses the pinned
Bun and Node.

| Hook         | Runs                                                                                                                                                                   | Skips when                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pre-commit` | On staged files: `gitleaks` for secrets, `oxlint --fix` and `stylelint --fix`, then `oxfmt`. Then `bun install --frozen-lockfile` and the typecheck of the staged tree | The install check and typecheck skip a docs-only commit                                                      |
| `commit-msg` | [`tools/hooks/commit-msg.ts`](../../../tools/hooks/commit-msg.ts) on the message: a Conventional Commits header, `type(scope)!: subject`, of 72 characters or fewer    | Git's own merge, revert, fixup and squash messages                                                           |
| `pre-push`   | `test`, `lint-policy-test`, `checks` (every fast check and `knip`) and `journeys`, with `CI=1` so the Nx cache matches `validate`                                      | `test`, `lint-policy-test` and `journeys` skip a docs-only push. Nothing runs when the push deletes a branch |

[`tools/hooks/paths.mjs`](../../../tools/hooks/paths.mjs) defines docs-only:
Markdown anywhere, any file under `docs/`, or a license text. A pushed branch is
compared with the remote tip. A new branch is compared with its merge base on
`origin/HEAD`.

Lint-staged hides unstaged changes while the pre-commit commands run. The
typecheck reads the staged tree, and the formatter changes only staged content.
Lint fixes run before formatting, because a lint fix can leave code unformatted.

Never skip a hook with `--no-verify`. When `pre-commit` or `pre-push` fails,
fix what it found. When a hook is wrong, fix the hook in its own change.

## Checks

Each repository check is a standalone script in `tools/check-*.ts`, with a
target on the root project. [`tools/docs-checks.test.ts`](../../../tools/docs-checks.test.ts)
tests the docs checks. [`tools/repo-checks.test.ts`](../../../tools/repo-checks.test.ts)
tests the workflow and dependency checks.

| Target                       | Rejects                                                                                                                                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint`                       | Oxlint rules, including the [import boundaries](../import-boundaries.md), and the [CSS lint](./lint-rules.md#css)                                                                                                                                                                                   |
| `lint-policy-test`           | A change to the import policy that breaks its fixtures                                                                                                                                                                                                                                              |
| `format-check`               | Oxfmt differences                                                                                                                                                                                                                                                                                   |
| `check-docs-file-refs`       | A doc link or path to a file that does not exist                                                                                                                                                                                                                                                    |
| `check-docs-temporal`        | Changelog phrases in durable docs                                                                                                                                                                                                                                                                   |
| `check-suppressions`         | A lint or type suppression comment, such as `oxlint-disable` or `@ts-expect-error`. See [lint rules](./lint-rules.md#how-a-rule-is-chosen)                                                                                                                                                          |
| `check-terms`                | A word from the [glossary](../glossary.md#rejected-words)'s rejected words table, or an em dash, in contributor docs                                                                                                                                                                                |
| `check-docs-claims`          | A doc sentence that says a check, lint rule, test or hook enforces a rule, but names none that exists                                                                                                                                                                                               |
| `check-agent-hooks`          | Claude Code and Codex configs that run different hooks, a hook script that no config calls, or a stale `.github/CODEOWNERS`. It must match the one-way-door tier of `.clutch/risk.yaml`. `bun tools/codeowners.ts --write` regenerates it. See [agent hooks](../harness-engineering.md#agent-hooks) |
| `check-sentences`            | A sentence over 25 words in `docs/`. Decision records, skills and `AGENTS.md` are exempt                                                                                                                                                                                                            |
| `check-commands`             | A command without its `.server.ts` half, a server half without its command or a registration in `runtime/`, or a command with no `waits`                                                                                                                                                            |
| `check-structure`            | A package folder that is not a section, a loose file in a package, or a feature without `gate.ts` or with other folders. `check-primitives` checks the primitive of each                                                                                                                            |
| `check-vendor-leaks`         | A vendor type in the built declarations of a public section. It runs after `typecheck`                                                                                                                                                                                                              |
| `check-bundle`               | A first screen of `apps/web` over 150 kB compressed, or with Effect code in it. It builds the app                                                                                                                                                                                                   |
| `check-decisions`            | Duplicate decision numbers, or an index that does not match                                                                                                                                                                                                                                         |
| `check-file-size`            | `AGENTS.md` over 20 lines, or a source file over its limit. See [file size](#file-size)                                                                                                                                                                                                             |
| `knip`                       | An unused file, export or dependency. See [dead code](#dead-code)                                                                                                                                                                                                                                   |
| `check-kickoff-slots`        | A kickoff slot left in a doc after `KICKOFF.md` is deleted                                                                                                                                                                                                                                          |
| `check-primitives`           | A broken [registry](../architecture/primitives.yaml) entry, or an Nx project with no primitive                                                                                                                                                                                                      |
| `check-workflows`            | A step or job reference that names nothing, a missing `permissions` block, `pull_request_target`, an unpinned `uses:`                                                                                                                                                                               |
| `check-workflow-lint`        | actionlint errors, shellcheck findings in `run:` scripts, and zizmor findings of medium severity or higher                                                                                                                                                                                          |
| `check-user-docs`            | A user page whose frontmatter breaks the table in [user docs](../../users/README.md)                                                                                                                                                                                                                |
| `check-migrations`           | A change, rename or deletion of a migration that reached `main`. See [migrations](./migrations.md)                                                                                                                                                                                                  |
| `check-guardrail-coverage`   | A file that a check, a lint plugin or a hook reads, with no pattern in `tools/guardrail-files.json`. See [guardrail files](../harness-engineering.md#guardrail-files)                                                                                                                               |
| `check-transaction-safe`     | A service that marks itself transaction-safe when `primitives.yaml` does not list it. See [server](../architecture/server.md#services-in-a-server-change)                                                                                                                                           |
| `check-test-integrity`       | A deleted test file, a test renamed so it does not run, or fewer tests or assertions in a test file. See [test integrity](../testing.md#test-integrity)                                                                                                                                             |
| `check-journeys`             | A shipped feature with no journey for its platform, a journey header with missing lines, or an unregistered journey. See [journeys](./verification.md#journeys)                                                                                                                                     |
| `check-clutch`               | A capability that `clutch.yaml` adopts but the repository lacks, a core gap with no waiver, an expired waiver, or a capability below `.clutch/doctor-baseline.json`. Run `bun run clutch doctor` to see why                                                                                         |
| `check-clutch-issues`        | A bad issue file in `.clutch/issues/`. The release regenerates `.clutch/TRACKER.md` on `main`, so a PR needs no fresh tracker                                                                                                                                                                       |
| `check-changeset`            | A change outside `.clutch/` with no changeset in `.changeset/`. A release range that only consumes changesets needs none. See [releases](./releases.md). Run `bun run pr open`, which writes one                                                                                                    |
| `check-db`                   | A schema change with no migration, or a migration that drizzle-kit did not write. See [migrations](./migrations.md#only-drizzle-kit-writes-migrations)                                                                                                                                              |
| `check-lockfile`             | A `bun.lock` that does not match the manifests                                                                                                                                                                                                                                                      |
| `check-dependency-overrides` | An override without a documented reason, a stale reason, or a repeated JSON key                                                                                                                                                                                                                     |
| `audit-prod`                 | A moderate or worse advisory in a production dependency                                                                                                                                                                                                                                             |

Add a check as `tools/check-<name>.ts`. Export a `check<Name>(root)` function
that returns the problems, so a test can call it on a temporary repository. Add
a test, a root target in `package.json`, the target in the `dependsOn` list of
the root `checks` target, and a row here. `validate` and the pre-push hook both
run `checks`, so the new check runs in both.

A failure message names the file, the problem and the fix. Print the fix hint
and a link to the page that owns the rule above the list of problems. See
[harness engineering](../harness-engineering.md#make-failures-teach-the-fix).

`check-workflows` reads each workflow with `Bun.YAML`. GitHub turns a
`steps.<id>` or `needs.<id>` reference to a missing step or job into an empty
string, and the run continues. See [CI](#ci) for the other three rules.

[Dependencies](./dependencies.md) explains `check-dependency-overrides` and
`audit-prod`. `audit-prod` needs network access.

## File size

A source or test file has at most 400 lines.
[`tools/file-size-budgets.json`](../../../tools/file-size-budgets.json) sets the
limit and lists the files that may pass it. The check skips files that Git
ignores, such as build output.

A deep module can be the right design: a small interface over a lot of logic,
where a split would only pass state between files. Such a file gets an entry
with a line budget and the reason it stays deep. Raise the budget in the same
change that grows the file, and update the reason when it changes. A review
reads the reason. `check-file-size` rejects:

- A file over the limit with no entry
- A file over its budget
- An entry with no reason
- An entry for a file that is within the limit, or for a file that does not exist

Never make code denser to fit a budget: no lists folded into a regex, no
helpers squeezed onto one line. Readable code with a raised budget is better
than dense code under the old one.

When a file outgrows its design, split it. A split keeps every test: the test
count is the same before and after.

## Dead code

`knip` reports unused files, exports and dependencies. It finds entry points
from the `package.json` scripts and the Nx targets.
[`knip.jsonc`](../../../knip.jsonc) adds the entries that it cannot find, such
as test files. Each added entry has a comment with its reason. A leftover is
deleted, not listed. See
[delete what is off the common path](../../principles/delete-off-the-common-path.md).

When a tool calls a file in a way that knip cannot see, run it through a
`package.json` script. The Git hooks do this: they call `hooks:pre-commit` and
`hooks:pre-push`.

## Test time budget

Each test target runs through
[`tools/test-budget.ts`](../../../tools/test-budget.ts). A suite that takes more
than 60 seconds fails, even when every test passes. A slow suite slows every
push, and it is often the first sign of a test that reaches the network or
builds too much setup.

When the budget fails, make the slowest tests faster. `bun test` prints the time
of each one. Never delete or skip a test to fit the budget. Raise a budget only
in a reviewed change that says why. The budget is the first argument of the
target's command in `package.json`.

## Test output

[`tools/testing/console-guard.ts`](../../../tools/testing/console-guard.ts) is
a test preload. `bunfig.toml` loads it for every `bun test` run. An unexpected
`console.error` or `console.warn` fails the test that logs it. The failure
prints the exact message.

When a test expects a message, allow that exact message in the test:

```ts
import { allowConsole } from '@tools/testing/console-guard';

test('a retry warns once', async () => {
  allowConsole('warn', 'sync: retry 2 of 3');
  await syncWithOneFailure();
});
```

The message is the logged arguments as `console` formats them. An Error shows
as `Name: message`, with no stack. `tools/testing/console-guard.ts` also fails
a test that allows a message and does not log it. Never replace `console.error` or `console.warn` with a
mock to hide output. A blanket mock hides the next regression too.

## Performance budgets

A performance check compares a measurement with a committed budget:

1. Keep the budget in a JSON file next to the check, such as
   `tools/<name>-budget.json`. A budget change is a reviewed diff.
2. Take three samples and compare the best one with the budget. The best sample
   drops runner noise. A real regression slows every sample.
3. Set the budget above the steady reading and below the level that hurts users.
4. When a change buys headroom, lower the budget in the same PR.
5. When growth is intentional, raise the budget in the same PR and give the
   reason in the PR description.

Run the check after the parallel targets, so other work does not inflate the
samples.

`check-bundle` is the budget for the first screen of `apps/web`. A byte count
does not vary between runs, so it takes one sample. See
[client performance](../architecture/client-performance.md).

<!-- kickoff: The performance budgets of the project: what each one measures (startup time, bundle bytes, query count), the budget file, the check target and the user cost it protects. Delete this slot when the project has no budget. -->

## Tools

- Typechecks use TSGo (`@typescript/native-preview`). Keep `typescript` only for
  tools that need its JavaScript compiler API.
- Lint uses Oxlint for code and Stylelint for CSS. Formatting uses Oxfmt.
- The lint rules and how each one is chosen are on
  [lint rules](./lint-rules.md).

```sh
mise exec -- bun run format   # write formatting
```

## CI

GitHub Actions runs the `validate` job on each PR and each push to `main`. On a
PR it runs `bun run validate --changed` against the PR's target branch, so it
checks only what the PR affects. See [only what changed](#only-what-changed).
A push to `main` runs the full `validate`, and so does a PR whose base is all
zeros. The job keeps the name `validate`, so the ruleset's required check still
matches. A second job, `journeys`, runs
every web journey in Chromium. See
[`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) and
[journeys](./verification.md#where-journeys-run).

Two more jobs repeat checks that a local hook also runs, because
`--no-verify` or another machine skips the hook. The `secrets` job scans the
PR's commits with gitleaks. The `commits` job checks each PR commit message
with the `commit-msg` rule in [Git hooks](#git-hooks).

The [Risk workflow](../../../.github/workflows/risk.yml) labels each PR
`risk/low`, `risk/medium`, `risk/high` or `risk/one-way-door` from the paths it
touches. It runs `clutch risk` from the base branch, with the rules in
`.clutch/risk.yaml`. See [risk](../../../apps/cli/README.md#risk). The
`one-way-door` tier holds the automation and its gates, agent steering, auth and
migrations. It also holds two lists that each project fills: its billing code,
and its infra, deploy and secrets paths.

The [Labels workflow](../../../.github/workflows/labels.yml) runs `clutch labels`
on each PR. It sets `kind/<type>` from the title and `area/<part>` for each
workspace package or top folder the PR touches. It also sets `size/S` to
`size/XL` by the changed lines. Above `pr_size.warn` in `clutch.yaml` the run
warns. Size never fails a PR. See
[labels](../review.md#labels).

<!-- kickoff: The globs of the project's payment and billing code, as the paths of the billing rule in .clutch/risk.yaml. Leave the list empty when the product bills nothing. -->

<!-- kickoff: The globs of the project's deploy config, infrastructure code and secret handling, as the paths of the infra, deploy and secrets rule in .clutch/risk.yaml. Leave the list empty when the project has none. -->

The [Auto-merge workflow](../../../.github/workflows/auto-merge.yml) runs when
CI or agent review completes on a branch of this repository, never a fork. It
judges an agent's `clutch/cl-` branch, and a bot's `renovate/` or `gardening/`
branch. It acts on `automerge.mode` and `automerge.step` in `clutch.yaml`. Its
`merge` job enables GitHub's auto-merge with the release bot, in the `release`
environment. See
[auto-merge](../../../.agents/skills/deliver/references/pull-requests.md#auto-merge).

- Each job names its runner image, `ubuntu-26.04`, not `ubuntu-latest`. A
  new image then arrives in a reviewed PR, not on GitHub's schedule.
- Each action runs on the Node.js 24 runtime. GitHub ends Node.js 20 for
  actions, and no action offers Node.js 26 yet.
- Each `uses:` pins a full commit SHA, with the release tag in a comment, such
  as `actions/checkout@<sha> # v7.0.1`. A tag or branch can move to other code
  after review. A reusable workflow from another repository, such as the Clutch
  doctor workflow, pins a SHA too. Only a local `./` path needs no pin.
  `check-workflows` rejects any other `uses:`, and its message names the
  `gh api` command that prints the SHA.
- `check-workflow-lint` runs actionlint and zizmor, at the versions in
  `mise.toml`. The first finds broken expressions and shell mistakes. The
  second finds unsafe patterns. Examples are an expression inside a `run:`
  script, a checkout that keeps its token, and an app token with every
  permission of the app. Pass an expression to a script through `env:`. Fix a
  finding, or narrow a permission. Do not add an ignore without the owner's
  approval. [`.github/actionlint.yaml`](../../../.github/actionlint.yaml)
  names the runner images that actionlint does not know yet.
- Each workflow sets a top-level `permissions` block. Start from
  `contents: read`, and grant more only in the job that needs it.
- A PR from a fork never gets a token that writes, such as a cache write token
  or a deploy token. GitHub withholds secrets from fork `pull_request` runs. Do
  not use `pull_request_target` to pass one. `check-workflows` rejects that
  trigger.
- A shared cache takes writes only from runs of people who can push to the
  repository. A fork PR job reads the cache at most.
- CI and the `validate` script both set `CI=1`. Nx test hashes include `CI`, so
  an agent run of `validate` and a CI run share cache keys. See
  [Nx](./nx.md#cache-keys).

<!-- kickoff: Each CI step that the project adds: native journeys, migration dry runs, preview deploys, the one-way-door label check. -->
