import { expect, test } from 'bun:test';

import { fake, noWrite, trunk } from '@tools/github/fake-run';
import { runPr } from '@tools/github/pr';
import type { Result } from '@tools/github/stack';

const syncAnswers = (
  rebase: Array<Partial<Result>>,
  conflicted: Array<Partial<Result>>,
  extra: Array<[string, Partial<Result>]> = [],
) =>
  fake([
    ...extra,
    trunk,
    [
      'gh pr view 7',
      {
        out: JSON.stringify({
          number: 7,
          url: 'https://github.com/o/r/pull/7',
          title: 'feat: x (CL-117)',
          body: 'Body',
          headRefName: 'clutch/cl-117-pr-lifecycle',
          baseRefName: 'main',
        }),
      },
    ],
    [
      'gh pr list --state open --head clutch/cl-117-pr-lifecycle',
      {
        out: '[{"number":7,"baseRefName":"main","url":"https://github.com/o/r/pull/7","isDraft":false}]',
      },
    ],
    ['git branch --show-current', { out: 'clutch/cl-117-pr-lifecycle\n' }],
    ['git rebase origin/main', rebase],
    ['git -c core.editor=true rebase --continue', { ok: true }],
    ['git diff --name-only --diff-filter=U', conflicted],
    ['git diff --name-only --diff-filter=A', { out: '.changeset/x.md' }],
  ]);

test('sync takes the base copy of a conflicted tracker, validates and pushes with a lease', async () => {
  const gh = syncAnswers([{ ok: false, err: 'CONFLICT' }], [{ out: '.clutch/TRACKER.md\n' }]);
  const logged: Array<string> = [];
  const original = console.log;
  console.log = (text: string) => logged.push(text);
  try {
    expect(await runPr(['sync', '7'], gh.run, noWrite)).toBe(0);
  } finally {
    console.log = original;
  }
  const order = [
    'git fetch --prune origin',
    'git rebase origin/main',
    'git checkout --ours -- .clutch/TRACKER.md',
    'git add .clutch/TRACKER.md',
    'git -c core.editor=true rebase --continue',
    'bun run validate',
    'git push --set-upstream --force-with-lease origin HEAD',
  ];
  const positions = order.map((call) => gh.calls.indexOf(call));
  expect(positions.every((position) => position !== -1)).toBe(true);
  expect(positions).toEqual(positions.toSorted((a, b) => a - b));
  expect(gh.calls).not.toContain('bun tools/clutch.ts issues --write');
  expect(logged).toContain('https://github.com/o/r/pull/7');
});

test('sync stops on a conflict outside the tracker', async () => {
  const gh = syncAnswers(
    [{ ok: false, err: 'CONFLICT' }],
    [{ out: '.clutch/TRACKER.md\ntools/github/pr.ts\n' }],
  );
  await expect(runPr(['sync', '7'], gh.run, noWrite)).rejects.toThrow(
    'The rebase stopped on tools/github/pr.ts.',
  );
  expect(gh.calls).not.toContain('bun run validate');
});

test('sync replays only its own commits when the stack base moved under it', async () => {
  const gh = syncAnswers(
    [{ ok: true }],
    [{ out: '' }],
    [
      ['git config --get branch.clutch/cl-117-pr-lifecycle.clutchForkPoint', { out: 'old1234\n' }],
      ['git merge-base --is-ancestor old1234 origin/main', { ok: false }],
      ['git merge-base HEAD origin/main', { out: 'new5678\n' }],
    ],
  );
  const original = console.log;
  console.log = () => {};
  try {
    expect(await runPr(['sync', '7'], gh.run, noWrite)).toBe(0);
  } finally {
    console.log = original;
  }
  expect(gh.calls).toContain('git rebase --onto origin/main old1234');
  expect(gh.calls).not.toContain('git rebase origin/main');
  expect(gh.calls).toContain(
    'git config branch.clutch/cl-117-pr-lifecycle.clutchForkPoint new5678',
  );
});

test('sync drops a fork point that the branch no longer contains', async () => {
  const gh = syncAnswers(
    [{ ok: true }],
    [{ out: '' }],
    [
      ['git config --get branch.clutch/cl-117-pr-lifecycle.clutchForkPoint', { out: 'gone123\n' }],
      ['git merge-base --is-ancestor gone123 HEAD', { ok: false }],
      ['git merge-base HEAD origin/main', { out: 'new5678\n' }],
    ],
  );
  const original = console.log;
  console.log = () => {};
  try {
    expect(await runPr(['sync', '7'], gh.run, noWrite)).toBe(0);
  } finally {
    console.log = original;
  }
  expect(gh.calls).toContain('git rebase origin/main');
  expect(gh.calls.some((call) => call.startsWith('git rebase --onto'))).toBe(false);
});

/** PR 9 on branch mid, in the stack 8 (low) -> 9 (mid) -> 11 (top). */
const middleOfStack = (extra: Array<[string, Partial<Result>]>) =>
  fake([
    ...extra,
    trunk,
    [
      'gh pr view 9',
      {
        out: JSON.stringify({
          number: 9,
          url: 'https://github.com/o/r/pull/9',
          title: 'feat: mid (CL-311)',
          body: 'Body',
          headRefName: 'mid',
          baseRefName: 'low',
        }),
      },
    ],
    [
      'gh pr list --state open --head mid',
      { out: '[{"number":9,"baseRefName":"low","url":"u9","isDraft":false}]' },
    ],
    [
      'gh pr list --state open --head low',
      { out: '[{"number":8,"baseRefName":"main","url":"u8","isDraft":false}]' },
    ],
    ['gh pr list --state open --base mid', { out: '[{"number":11,"headRefName":"top"}]' }],
    ['gh pr list --state open --base top', { out: '[]' }],
    ['git branch --show-current', { out: 'mid\n' }],
    ['git diff --name-only --diff-filter=A', { out: '.changeset/x.md' }],
  ]);

const quietly = async (work: () => Promise<number>) => {
  const original = console.log;
  console.log = () => {};
  try {
    return await work();
  } finally {
    console.log = original;
  }
};

test('sync on the middle PR of a stack links the whole stack, the PRs above it too', async () => {
  const gh = middleOfStack([]);
  expect(await quietly(() => runPr(['sync', '9'], gh.run, noWrite))).toBe(0);
  expect(gh.calls).toContain('gh stack link 8 9 11 --open');
});

test('sync finds the fork point in the base PR force pushes when this clone recorded none', async () => {
  const gh = middleOfStack([
    // The PR below was rebased: its head before the force push is old1111.
    ['gh api graphql', { out: 'old1111\n' }],
    ['git merge-base --fork-point', { ok: false }],
    ['git merge-base --is-ancestor old1111 HEAD', { ok: true }],
    ['git merge-base --is-ancestor old1111 origin/low', { ok: false }],
  ]);
  expect(await quietly(() => runPr(['sync', '9'], gh.run, noWrite))).toBe(0);
  expect(gh.calls).toContain('git rebase --onto origin/low old1111');
  expect(gh.calls).not.toContain('git rebase origin/low');
});
