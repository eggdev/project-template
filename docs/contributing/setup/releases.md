# Releases

Each merge to `main` is a release with a semver version. A changeset in each
pull request says how large the change is. The release turns the changesets
into one version and one section of `CHANGELOG.md`.

## Changesets

A changeset is one Markdown file in `.changeset/`. Its frontmatter names the
bump, and its body is a one-line summary for the changelog:

```md
---
'clutch': minor
---

feat(cli): add clutch init
```

- `patch` is a fix or maintenance, `minor` is a feature, and `major` is a
  breaking change.
- `mise exec -- bun run pr open` writes the changeset from the conventional PR
  title when the branch has none. `fix` gives `patch`, `feat` gives `minor`,
  and `!` gives `major`.
- The gardening workflow writes its PR's changeset the same way, from the
  title the agent returns.
- Self-hosted Renovate writes a `patch` changeset for each of its PRs, from
  the PR title. A post-upgrade task runs
  `tools/release/renovate-changeset.mjs`. See
  [Renovate](./dependencies.md#renovate).
- `check-changeset` fails a change outside `.clutch/` that has no changeset.
  A release needs none. Its range may touch only the release output: deleted
  changesets, `CHANGELOG.md` and the root `package.json`. It passes when it
  consumes a changeset, or when each of its commits is a `chore(release):
  vX.Y.Z` commit by `github-actions[bot]`. Its tests are in
  `tools/check-changeset.test.ts`.

## Versions and the changelog

A release reads every pending changeset. The largest bump decides the next
version in the root `package.json`. The release adds one section to
`CHANGELOG.md`, with the summaries grouped by bump, and deletes the changesets.
A stack that merges at once is one release, with one line for each pull
request.

## The release workflow

[`release.yml`](../../../.github/workflows/release.yml) runs on each push to
`main`, one run at a time. It checks out the latest `main`, so it sees each
earlier release commit. When changesets are pending, it does these steps:

1. It writes the version and `CHANGELOG.md` with
   [`tools/release/release.ts`](../../../tools/release/release.ts).
2. It regenerates `.clutch/TRACKER.md` from the issue files with
   `clutch issues --write`.
3. It commits them as `chore(release): vX.Y.Z` with the GitHub Actions bot.
4. It tags `vX.Y.Z` and pushes the commit and the tag to `main`.
5. It publishes a GitHub release with the changelog section as its notes and
   the `clutch` binaries.

With no pending changesets, the workflow makes no release. When the issue
files changed the tracker, it commits `chore(tracker): regenerate the tracker`
instead. Pull requests never commit the tracker, so two open PRs never conflict on it.
A sync never has to push a tracker fix to an approved PR. The push is
atomic, so a refused push to `main` leaves no tag behind.

## The release bot

A protected `main` refuses a direct push. Only an actor on the ruleset's bypass
list can push the release commit, and the default Actions token cannot be on
that list. So the release pushes with a GitHub App token, the release bot. The
gardening workflow opens its pull request with the same token, so CI runs on
that PR. The Auto-merge workflow merges with it, so the release runs after an
auto-merge. The Revert workflow pushes and opens each revert PR with it, for the
same reason. The Grade verdicts workflow adds the owner's grades as the bot.
The Open PR workflow opens each agent PR with it, so the owner
can approve it. See
[who opens the pull request](../../../.agents/skills/deliver/references/pull-requests.md#who-opens-the-pull-request).
Self-hosted Renovate signs in with it too. See
[Renovate](./dependencies.md#renovate).

Without the app, these workflows use the default token. Once `main` has a
ruleset, the release push then fails, so set the bot up before the ruleset. Set the bot up once per repository:

1. Create a private GitHub App with no webhook. Give it the repository
   permissions Contents, Pull requests and Workflows, each read and write.
   Renovate needs Workflows to update action pins. See
   [Renovate](./dependencies.md#renovate).
2. Install the app on the repository.
3. Set the `CLUTCH_APP_ID` repository variable to the app id.
4. Create the `release` environment, which only the default branch may deploy
   to. Replace `<repo>` with `owner/name`, and `main` with the default branch:

   ```sh
   gh api -X PUT repos/<repo>/environments/release \
     -F 'deployment_branch_policy[protected_branches]=false' \
     -F 'deployment_branch_policy[custom_branch_policies]=true'
   gh api -X POST repos/<repo>/environments/release/deployment-branch-policies \
     -f name=main -f type=branch
   ```

5. Generate a private key for the app. Store it as the
   `CLUTCH_APP_PRIVATE_KEY` secret of the `release` environment, never as a
   repository secret:

   ```sh
   gh secret set CLUTCH_APP_PRIVATE_KEY --env release --repo <repo> < <key>.pem
   ```

6. Run `mise exec -- bun run clutch ruleset --apply`. The `main` ruleset in
   `.github/rulesets/main.json` names the bot's bypass with
   `"actor_id": "vars.CLUTCH_APP_ID"`, and the command puts in the variable's
   value.

Each job that mints the bot token names `environment: release`, so only a run
on the default branch can read the key. A workflow that a pull request starts
cannot, so the Revert workflow starts a run of itself on the default branch.
A job in an environment still reads repository secrets, and the environment's
secret wins when both exist. When a job names an environment that does not exist,
GitHub creates it with no branch rule, so run step 4 in each repository.

### Move the key into the environment

An older setup keeps the key as a repository secret, which every branch's runs
can read. Secrets cannot be copied, so upload the key again:

1. Make sure the `release` environment exists, as in step 4 above. Until the
   next step, the workflows read the repository secret, so releases keep
   working.
2. Upload the key to the environment:
   `gh secret set CLUTCH_APP_PRIVATE_KEY --env release --repo <repo> < <key>.pem`.
3. Run a workflow that mints the token, such as Renovate from the Actions tab,
   and check that the token step passes.
4. Delete the repository secret:
   `gh secret delete CLUTCH_APP_PRIVATE_KEY --repo <repo>`.

<!-- kickoff: Whether this project has its own release bot app, and who holds its private key. -->

## The clutch binary

[`tools/release/binaries.ts`](../../../tools/release/binaries.ts) compiles
`apps/cli` with `bun build --compile` for Linux and macOS, on x64 and arm64.
Each release carries one `clutch-<os>-<arch>.tar.gz` per platform, with one
`clutch` file inside. mise's `github:eggdev/clutch` backend picks the archive
for the machine. Only Clutch has `apps/cli`, so a project's release has no
binaries.

## A project's changelog

`CHANGELOG.md` holds the releases of its own repository. Install and sync never
copy the changelog or the pending changesets of Clutch. Install and
`clutch init` give a new project a `CHANGELOG.md` with a title and no entries,
and `.changeset/README.md`. The project's first release writes its first entry.

[`tools/release/changeset.ts`](../../../tools/release/changeset.ts) holds the
format, the bump rules and the changelog section.
