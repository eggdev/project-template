import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { must, prWithHead } from '@tools/github/github';
import type { Run } from '@tools/github/stack';

const tracker = '.clutch/TRACKER.md';

/**
 * The tracker commands, through `tools/clutch.ts`. In Clutch that runs the
 * CLI source. In a project it runs the release binary that mise installs.
 */
const clutch = (...args: Array<string>) => ['bun', 'tools/clutch.ts', ...args];

/** The prefix of an agent's branch: `pr.branchPrefix` in clutch.yaml, or `clutch/cl-`. */
async function branchPrefix(root: string) {
  const file = Bun.file(path.join(root, 'clutch.yaml'));
  const config = (await file.exists())
    ? (Bun.YAML.parse(await file.text()) as { pr?: { branchPrefix?: unknown } } | null)
    : null;
  const prefix = config?.pr?.branchPrefix;
  return typeof prefix === 'string' && prefix !== '' ? prefix : 'clutch/cl-';
}

type Pr = { number: number; url: string; title: string; body: string; head: string; base: string };

async function view(run: Run, number: string): Promise<Pr> {
  const out = await must(run, [
    'gh',
    'pr',
    'view',
    number,
    '--json',
    'number,url,title,body,headRefName,baseRefName',
  ]);
  const pr = JSON.parse(out) as Omit<Pr, 'head' | 'base'> & {
    headRefName: string;
    baseRefName: string;
  };
  return { ...pr, head: pr.headRefName, base: pr.baseRefName };
}

/** The PR that `target` names: a number, a branch, or an issue id such as CL-117. */
async function resolve(run: Run, root: string, target: string) {
  if (/^\d+$/u.test(target)) {
    return view(run, target);
  }
  let branch = target;
  if (/^CL-\d{3}[a-z]?$/iu.test(target)) {
    const prefix = `${await branchPrefix(root)}${target.slice(3).toLowerCase()}-`;
    const out = await must(run, ['gh', 'pr', 'list', '--state', 'open', '--json', 'headRefName']);
    const heads = (JSON.parse(out || '[]') as Array<{ headRefName: string }>)
      .map((pr) => pr.headRefName)
      .filter((head) => head.startsWith(prefix));
    if (heads.length !== 1) {
      throw new Error(`${heads.length} open PRs have a branch that starts with ${prefix}.`);
    }
    [branch] = heads;
  }
  const found = await prWithHead(run, branch);
  if (!found) {
    throw new Error(`No open PR has the head ${branch}.`);
  }
  return view(run, String(found.number));
}

const forkKey = (branch: string) => `branch.${branch}.clutchForkPoint`;

/**
 * Remembers where a stacked branch left its base, in the clone's git config.
 * When the base is later rewritten, or merges into the default branch with
 * other commits, `pr sync` replays only the branch's own commits.
 */
export async function recordForkPoint(run: Run, branch: string, base: string) {
  const point = await must(run, ['git', 'merge-base', 'HEAD', `origin/${base}`]);
  await must(run, ['git', 'config', forkKey(branch), point]);
}

/** The files with a merge conflict. */
async function conflicts(run: Run) {
  const out = await must(run, ['git', 'diff', '--name-only', '--diff-filter=U']);
  return out.split('\n').filter(Boolean);
}

/**
 * Rebases the PR's branch on its base. A PR never commits the tracker, which
 * the release generates on the default branch, so a conflict in it comes from
 * an older branch: the base's copy wins. Any other conflict stops, with the
 * rebase left in progress for the author to finish.
 */
/** Whether `commit` is an ancestor of `of`. */
async function contains(run: Run, commit: string, of: string) {
  const result = await run(['git', 'merge-base', '--is-ancestor', commit, of]);
  return result.ok;
}

/**
 * The commits that a rewrite of the base PR left behind: the head before each
 * force push, newest first. They are where a branch stacked on it may fork.
 */
async function forcePushedHeads(run: Run, base: string) {
  const below = await prWithHead(run, base);
  if (!below) {
    return [];
  }
  const result = await run([
    'gh',
    'api',
    'graphql',
    '-F',
    'owner={owner}',
    '-F',
    'name={repo}',
    '-F',
    `number=${below.number}`,
    '-f',
    'query=query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { timelineItems(last: 50, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) { nodes { ... on HeadRefForcePushedEvent { beforeCommit { oid } } } } } } }',
    '--jq',
    '.data.repository.pullRequest.timelineItems.nodes[].beforeCommit.oid',
  ]);
  return result.ok ? result.out.split('\n').filter(Boolean).toReversed() : [];
}

/**
 * Where the branch left its base. In order: the point that pr open or pr sync
 * recorded in this clone, Git's fork point from the reflog of the base, then
 * the newest head that the base PR had before a force push. A point counts
 * only when the branch still contains it, since a branch rebased by hand sits
 * on the base it was rebased onto.
 */
async function forkPoint(run: Run, branch: string, base: string) {
  const recorded = await run(['git', 'config', '--get', forkKey(branch)]);
  const reflog = await run(['git', 'merge-base', '--fork-point', `origin/${base}`, 'HEAD']);
  const candidates = [recorded, reflog].flatMap((result) =>
    result.ok && result.out.trim() ? [result.out.trim()] : [],
  );
  for (const point of [...candidates, ...(await forcePushedHeads(run, base))]) {
    if (await contains(run, point, 'HEAD')) {
      return point;
    }
  }
  return '';
}

async function rebase(run: Run, branch: string, base: string) {
  const point = await forkPoint(run, branch, base);
  // A fork point that the new base does not contain means the base moved under
  // the branch, so the commits below the point are not the branch's own.
  const moved = point !== '' && !(await contains(run, point, `origin/${base}`));
  let step = await run(
    moved
      ? ['git', 'rebase', '--onto', `origin/${base}`, point]
      : ['git', 'rebase', `origin/${base}`],
  );
  for (let round = 0; !step.ok && round < 100; round += 1) {
    const files = await conflicts(run);
    const other = files.filter((file) => file !== tracker);
    if (files.length === 0 || other.length > 0) {
      throw new Error(
        `The rebase stopped on ${other.join(', ') || 'an error'}. Resolve it, run git rebase --continue, then run pr sync again.\n${step.err || step.out}`,
      );
    }
    // In a rebase, "ours" is the base that the commits are replayed onto.
    await must(run, ['git', 'checkout', '--ours', '--', tracker]);
    await must(run, ['git', 'add', tracker]);
    step = await run(['git', '-c', 'core.editor=true', 'rebase', '--continue']);
  }
}

/**
 * `pr sync`: brings a PR's branch up to date with its base, checks it, and
 * pushes it with a lease, keeping the title and the body.
 */
export async function sync(
  run: Run,
  root: string,
  target: string,
  open: (options: {
    title: string;
    'body-file': string;
    base: string;
    force: true;
  }) => Promise<number>,
) {
  const pr = await resolve(run, root, target);
  if ((await must(run, ['git', 'status', '--porcelain'])) !== '') {
    throw new Error('Commit or stash your changes before pr sync.');
  }
  if ((await must(run, ['git', 'branch', '--show-current'])) !== pr.head) {
    await must(run, ['git', 'switch', pr.head]);
  }
  await must(run, ['git', 'fetch', '--prune', 'origin']);
  await rebase(run, pr.head, pr.base);
  // The branch now sits on the base's tip, the fork point for the next sync.
  await recordForkPoint(run, pr.head, pr.base);
  await must(run, ['bun', 'run', 'validate'], { inherit: true });
  const folder = await mkdtemp(path.join(tmpdir(), 'pr-sync-'));
  const body = path.join(folder, 'body.md');
  await writeFile(body, pr.body);
  return open({ title: pr.title, 'body-file': body, base: pr.base, force: true });
}

/**
 * `pr ready`: the last commit of a green PR. It marks the issue done with the
 * PR's link, commits only the issue file and pushes. The release regenerates
 * the tracker on the default branch.
 */
export async function ready(run: Run, root: string, id: string, number: string) {
  const pr = await view(run, number);
  const expected = `${await branchPrefix(root)}${id.slice(3).toLowerCase()}`;
  if (!pr.head.startsWith(expected)) {
    console.log(`Note: the branch ${pr.head} does not start with ${expected}.`);
  }
  if ((await must(run, ['git', 'branch', '--show-current'])) !== pr.head) {
    throw new Error(`Switch to ${pr.head}, the branch of #${pr.number}, first.`);
  }
  await must(run, clutch('issues', 'set', id, 'done', '--pr', pr.url));
  await must(run, ['git', 'add', '.clutch/issues']);
  await must(run, [
    'git',
    'commit',
    '--quiet',
    '--message',
    `chore(tracker): mark ${id} done`,
    '--',
    '.clutch/issues',
  ]);
  const pushed = await run(['git', 'push', 'origin', 'HEAD'], { inherit: true });
  if (!pushed.ok) {
    throw new Error('The push failed. Read the git output above.');
  }
  console.log(`${id} is done in ${pr.url}. Merge it once the checks pass again.`);
  return 0;
}
