import { expect, test } from 'bun:test';
import {
  appendFile,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildBinaries } from '@tools/release/binaries';

/**
 * `bun run pr` in a project that `clutch init` made, with the release binary
 * on PATH and no Clutch source. Git runs for real against a local origin. A
 * fake `gh` answers GitHub, since the test stays offline.
 */
const root = path.resolve(import.meta.dir, '../..');
const bunDir = path.dirname(process.execPath);

const issue = (id: string, status: string) => `---
id: ${id}
title: 'Issue ${id}'
phase: P0
status: ${status}
depends_on: []
pr: ''
owner: agent
---

# ${id}: Issue ${id}
`;

function sh(cmd: Array<string>, cwd: string, env: Record<string, string>) {
  const proc = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env } });
  return { code: proc.exitCode, out: `${proc.stdout}${proc.stderr}` };
}

/** The fake `gh`: it answers each call from FAKE_GH by the longest matching prefix and logs it. */
const fakeGh = `
const args = process.argv.slice(2).join(' ');
await (await import('node:fs/promises')).appendFile(process.env.FAKE_GH_LOG, args + '\\n');
const answers = JSON.parse(await Bun.file(process.env.FAKE_GH).text());
const key = Object.keys(answers).filter((prefix) => args.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
const answer = key === undefined ? { out: '' } : answers[key];
process.stdout.write(answer.out ?? '');
process.stderr.write(answer.err ?? '');
process.exit(answer.code ?? 0);
`;

test('the pr commands run in a project made by clutch init', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'clutch-pr-'));
  try {
    const bin = path.join(parent, 'bin');
    await mkdir(bin);
    const [archive] = await buildBinaries(root, path.join(parent, 'dist'), [
      `${process.platform}-${process.arch}`,
    ]);
    sh(['tar', '-xzf', archive, '-C', bin], parent, {});
    await writeFile(path.join(parent, 'fake-gh.ts'), fakeGh);
    await writeFile(
      path.join(bin, 'gh'),
      `#!/bin/sh\nexec "${process.execPath}" "${path.join(parent, 'fake-gh.ts')}" "$@"\n`,
    );
    await chmod(path.join(bin, 'gh'), 0o755);

    // A tiny Clutch upstream, read through a cached clone as the binary does.
    const upstream = path.join(parent, 'upstream');
    await mkdir(upstream);
    await writeFile(path.join(upstream, 'clutch.files.yaml'), 'version: 1\nfiles: []\n');
    const env = {
      PATH: `${bin}${path.delimiter}${bunDir}${path.delimiter}${process.env.PATH}`,
      XDG_CACHE_HOME: path.join(parent, 'cache'),
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: `url.${upstream}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/eggdev/clutch.git',
      GIT_CONFIG_KEY_1: 'user.name',
      GIT_CONFIG_VALUE_1: 't',
      GIT_CONFIG_KEY_2: 'user.email',
      GIT_CONFIG_VALUE_2: 't@t',
      FAKE_GH: path.join(parent, 'gh.json'),
      FAKE_GH_LOG: path.join(parent, 'gh.log'),
    };
    const git = (cwd: string, ...args: Array<string>) => sh(['git', ...args], cwd, env);
    git(upstream, 'init', '--quiet', '--initial-branch=main');
    git(upstream, 'add', '--all');
    git(upstream, 'commit', '--quiet', '--message', 'First');
    git(upstream, 'tag', 'v0.1.0');

    const dir = path.join(parent, 'shop');
    await mkdir(dir);
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'shop', version: '0.1.0', scripts: { validate: 'true' } }),
    );
    // The project's own formatter, which the binary uses to write files.
    await mkdir(path.join(dir, 'node_modules/.bin'), { recursive: true });
    await symlink(path.join(root, 'node_modules/oxfmt'), path.join(dir, 'node_modules/oxfmt'));
    await symlink('../oxfmt/bin/oxfmt', path.join(dir, 'node_modules/.bin/oxfmt'));
    await cp(path.join(root, '.oxfmtrc.json'), path.join(dir, '.oxfmtrc.json'));
    await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
    git(dir, 'init', '--quiet', '--initial-branch=main');
    git(dir, 'add', '--all');
    git(dir, 'commit', '--quiet', '--message', 'Start');
    expect(sh(['clutch', 'init', '--yes'], dir, env)).toMatchObject({ code: 0 });
    expect(await Bun.file(path.join(dir, 'clutch.yaml')).exists()).toBe(true);

    // What sync copies into a project: the pr tools and the clutch launcher.
    for (const folder of ['tools/github', 'tools/hooks', 'tools/release']) {
      await cp(path.join(root, folder), path.join(dir, folder), { recursive: true });
    }
    await cp(path.join(root, 'tools/clutch.ts'), path.join(dir, 'tools/clutch.ts'));
    await writeFile(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { paths: { '@tools/*': ['./tools/*'] } } }),
    );
    await mkdir(path.join(dir, '.clutch/issues'), { recursive: true });
    for (const id of ['CL-001', 'CL-002', 'CL-003']) {
      await writeFile(path.join(dir, `.clutch/issues/${id}.md`), issue(id, 'todo'));
    }
    const clutch = (...args: Array<string>) => sh(['bun', 'tools/clutch.ts', ...args], dir, env);
    expect(clutch('issues', '--write')).toMatchObject({ code: 0 });
    git(dir, 'add', '--all');
    git(dir, 'commit', '--quiet', '--message', 'chore: adopt clutch');
    const origin = path.join(parent, 'origin.git');
    git(parent, 'init', '--quiet', '--bare', origin);
    git(dir, 'remote', 'add', 'origin', origin);
    git(dir, 'push', '--quiet', 'origin', 'main');

    // An older branch that still committed the tracker changes CL-002, and main moves on
    // with CL-003, so only the tracker conflicts. The base's copy wins.
    git(dir, 'switch', '--quiet', '-c', 'clutch/cl-002-thing');
    await writeFile(path.join(dir, '.clutch/issues/CL-002.md'), issue('CL-002', 'in_progress'));
    clutch('issues', '--write');
    git(dir, 'commit', '--quiet', '--all', '--message', 'feat: start CL-002');
    git(dir, 'push', '--quiet', 'origin', 'HEAD');
    git(dir, 'switch', '--quiet', 'main');
    await writeFile(path.join(dir, '.clutch/issues/CL-003.md'), issue('CL-003', 'in_progress'));
    clutch('issues', '--write');
    git(dir, 'commit', '--quiet', '--all', '--message', 'feat: start CL-003');
    git(dir, 'push', '--quiet', 'origin', 'main');
    git(dir, 'reset', '--quiet', '--hard', 'HEAD~1');
    git(dir, 'switch', '--quiet', 'clutch/cl-002-thing');

    const pull = {
      number: 7,
      url: 'https://github.com/acme/shop/pull/7',
      title: 'feat: add the thing (CL-002)',
      body: 'Body',
      headRefName: 'clutch/cl-002-thing',
      baseRefName: 'main',
    };
    const listed = { number: 7, baseRefName: 'main', url: pull.url, isDraft: false };
    await writeFile(
      env.FAKE_GH,
      JSON.stringify({
        'repo view': { out: 'main\n' },
        'pr view 7': { out: JSON.stringify(pull) },
        'pr list --state open --head clutch/cl-002-thing': { out: JSON.stringify([listed]) },
      }),
    );
    const pr = (...args: Array<string>) => sh(['bun', 'tools/github/pr.ts', ...args], dir, env);

    const synced = pr('sync', '7');
    expect(synced).toMatchObject({ code: 0 });
    expect(git(dir, 'log', '--format=%s', 'origin/clutch/cl-002-thing').out).toContain(
      'feat: start CL-003',
    );
    const merged = await readFile(path.join(dir, '.clutch/TRACKER.md'), 'utf-8');
    expect(merged).not.toContain('<<<<<<<');
    // main's tracker, which the release generated. The PR does not regenerate it.
    expect(merged).toMatch(/CL-003 .*in_progress/u);
    expect(merged).not.toMatch(/CL-002 .*in_progress/u);
    expect(clutch('issues', '--check')).toMatchObject({ code: 0 });

    expect(pr('ready', 'CL-002', '7')).toMatchObject({ code: 0 });
    expect(git(dir, 'log', '-1', '--format=%s', 'origin/clutch/cl-002-thing').out.trim()).toBe(
      'chore(tracker): mark CL-002 done',
    );
    expect(await readFile(path.join(dir, '.clutch/issues/CL-002.md'), 'utf-8')).toContain(
      `pr: '${pull.url}'`,
    );
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').out.trim()).toBe(
      '.clutch/issues/CL-002.md',
    );

    // GitHub reports the commit that ready pushed, so pr wait sees its own head.
    const pushed = git(dir, 'rev-parse', 'HEAD').out.trim();
    await writeFile(
      env.FAKE_GH,
      JSON.stringify({
        'repo view': { out: 'main\n' },
        'pr view 7 --json mergeCommit': { out: 'abc\n' },
        'pr view 7 --json number,url,state': {
          out: JSON.stringify({
            ...pull,
            state: 'OPEN',
            headRefOid: pushed,
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [
              {
                __typename: 'CheckRun',
                name: 'validate',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
              },
            ],
          }),
        },
        'pr view 7': { out: JSON.stringify(pull) },
        'api repos/{owner}/{repo}/rules': { out: '["validate"]' },
        'pr list --state open --base': { out: '[]' },
        'run list': {
          out: JSON.stringify([
            { headSha: 'abc', status: 'completed', conclusion: 'success', url: 'u' },
          ]),
        },
      }),
    );
    await appendFile(env.FAKE_GH_LOG, '-- github\n');
    expect(pr('status', '7').out).toContain('Ready to merge: yes');
    expect(pr('wait', '7', '--timeout', '1m')).toMatchObject({ code: 0 });
    expect(pr('failures', '7').out).toContain('No check failed.');
    const merge = pr('merge', '7');
    expect(merge).toMatchObject({ code: 0 });
    expect(merge.out).toContain('Released v0.1.0');
    const log = await readFile(env.FAKE_GH_LOG, 'utf-8');
    expect(log).toContain('pr merge 7 --merge');
    expect(log).not.toContain('eggdev');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);
