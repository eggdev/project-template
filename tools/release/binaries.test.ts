import { expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildBinaries } from '@tools/release/binaries';

const root = path.resolve(import.meta.dir, '../..');

const issue = `---
id: CL-001
title: 'Ship the shop'
phase: P0
status: todo
depends_on: []
pr: ''
owner: agent
---

# CL-001: Ship the shop
`;

function run(cmd: Array<string>, cwd: string, PATH: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env, PATH } });
  return { code: proc.exitCode, out: `${proc.stdout}${proc.stderr}` };
}

const git = (cwd: string, ...args: Array<string>) =>
  run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], cwd, process.env.PATH ?? '');

/** A Clutch repository with two releases. The second changes the managed file. */
async function upstream(parent: string) {
  const dir = path.join(parent, 'upstream');
  await mkdir(path.join(dir, 'lib'), { recursive: true });
  await writeFile(
    path.join(dir, 'clutch.files.yaml'),
    'version: 1\nfiles:\n  - path: lib/\n    rule: managed\n',
  );
  await writeFile(path.join(dir, 'lib/check.ts'), 'v1\n');
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'add', '--all');
  git(dir, 'commit', '--quiet', '--message', 'First');
  git(dir, 'tag', 'v0.1.0');
  await writeFile(path.join(dir, 'lib/check.ts'), 'v2\n');
  git(dir, 'commit', '--quiet', '--all', '--message', 'Second');
  git(dir, 'tag', 'v0.2.0');
  return dir;
}

/** A project from Clutch: the tracker, the launcher and its own formatter, but no `apps/cli/`. */
async function project(parent: string) {
  const dir = path.join(parent, 'shop');
  await mkdir(path.join(dir, '.clutch/issues'), { recursive: true });
  await mkdir(path.join(dir, 'tools'));
  await mkdir(path.join(dir, 'node_modules/.bin'), { recursive: true });
  await writeFile(path.join(dir, '.clutch/issues/CL-001.md'), issue);
  await writeFile(
    path.join(dir, 'clutch.yaml'),
    'schemaVersion: 1\nproject: shop\ntemplate:\n  repo: eggdev/clutch\n  mode: sync\ncapabilities: {}\n',
  );
  await writeFile(path.join(dir, '.gitignore'), 'node_modules/\n');
  await copyFile(path.join(root, 'tools/clutch.ts'), path.join(dir, 'tools/clutch.ts'));
  await copyFile(path.join(root, '.oxfmtrc.json'), path.join(dir, '.oxfmtrc.json'));
  await symlink(path.join(root, 'node_modules/oxfmt'), path.join(dir, 'node_modules/oxfmt'));
  await symlink('../oxfmt/bin/oxfmt', path.join(dir, 'node_modules/.bin/oxfmt'));
  git(dir, 'init', '--quiet', '--initial-branch=main');
  git(dir, 'add', '--all');
  git(dir, 'commit', '--quiet', '--message', 'Start');
  return dir;
}

test('a project runs the clutch commands through the launcher and the release binary', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'clutch-binary-'));
  try {
    const [archive] = await buildBinaries(root, path.join(parent, 'dist'), [
      `${process.platform}-${process.arch}`,
    ]);
    const bin = path.join(parent, 'bin');
    await mkdir(bin);
    expect(run(['tar', '-xzf', archive, '-C', bin], parent, process.env.PATH ?? '').code).toBe(0);
    const dir = await project(parent);
    // Git reads the local Clutch for github.com/eggdev/clutch, so the test stays offline.
    const env = {
      XDG_CACHE_HOME: path.join(parent, 'cache'),
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${await upstream(parent)}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/eggdev/clutch.git',
    };
    const PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    const clutch = (...args: Array<string>) =>
      run([process.execPath, 'tools/clutch.ts', ...args], dir, PATH, env);

    const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf-8'));
    expect(clutch('--version')).toEqual({ code: 0, out: `${version}\n` });

    expect(clutch('issues', 'set', 'CL-001', 'in_progress')).toMatchObject({ code: 0 });
    expect(await readFile(path.join(dir, '.clutch/issues/CL-001.md'), 'utf-8')).toContain(
      'in_progress',
    );
    // The release writes the tracker on main. Locally, --write renders it.
    expect(clutch('issues', '--write')).toMatchObject({ code: 0 });
    expect(await readFile(path.join(dir, '.clutch/TRACKER.md'), 'utf-8')).toContain('in_progress');
    expect(clutch('issues', '--check')).toEqual({ code: 0, out: '' });
    expect(clutch('issues', 'next').out).toBe('No unblocked issue.\n');
    const created = clutch('issues', 'new', '--phase', 'P0', '--title', 'Add the cart');
    expect(created).toEqual({
      code: 0,
      out: 'CL-002  .clutch/issues/CL-002.md\n',
    });
    expect(await readFile(path.join(dir, '.clutch/issues/CL-002.md'), 'utf-8')).toContain(
      "title: 'Add the cart'\nphase: P0\nstatus: todo",
    );
    expect(clutch('issues', '--check')).toEqual({ code: 0, out: '' });
    git(dir, 'add', '--all');
    git(dir, 'commit', '--quiet', '--message', 'File CL-002');

    const behind = clutch('sync', '--check');
    expect(behind.code).toBe(2);
    expect(behind.out).toContain('The project would move to Clutch v0.2.0, the latest release.');
    expect(clutch('sync')).toMatchObject({ code: 0 });
    expect(await readFile(path.join(dir, 'lib/check.ts'), 'utf-8')).toBe('v2\n');
    git(dir, 'add', '--all');
    git(dir, 'commit', '--quiet', '--message', 'Sync');
    expect(clutch('sync', '--check')).toMatchObject({ code: 0 });

    const doctor = clutch('doctor', '--json');
    expect(doctor.code).toBe(0);
    expect(JSON.parse(doctor.out)).toMatchObject({ templateRelease: 'v0.2.0' });
    // The binary reports each capability of the registry that it carries.
    const registry = Bun.YAML.parse(
      await readFile(path.join(root, 'docs/contributing/capabilities/registry.yaml'), 'utf-8'),
    ) as { capabilities: Array<unknown> };
    expect(JSON.parse(doctor.out).results).toHaveLength(registry.capabilities.length);

    const install = clutch('install', '--yes');
    expect(install.code).toBe(1);
    expect(install.out).toContain('clutch install runs from a Clutch clone.');

    const bare = run(
      [process.execPath, 'tools/clutch.ts', 'issues'],
      dir,
      path.dirname(process.execPath),
    );
    expect(bare.code).toBe(1);
    expect(bare.out).toContain('The clutch binary is not installed.');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 30_000);
