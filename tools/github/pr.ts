import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { openAsBot } from '@tools/github/bot-open';
import { ready, recordForkPoint, sync } from '@tools/github/branch';
import { failures, renderFailures } from '@tools/github/failures';
import {
  defaultBranch,
  duration,
  must,
  prWithBase,
  prWithHead,
  realClock,
} from '@tools/github/github';
import type { Clock } from '@tools/github/github';
import { merge } from '@tools/github/merge';
import {
  ghStack,
  ghVersion,
  pinnedGh,
  stackAbove,
  stackChain,
  stackExtensionVersion,
} from '@tools/github/stack';
import type { Run } from '@tools/github/stack';
import { prStatus, renderStatus, waitForChecks } from '@tools/github/status';
import type { PrStatus } from '@tools/github/status';
import { conventionalProblem } from '@tools/hooks/commit-msg';
import { bumpOf, changesetDir, changesetText, packageName } from '@tools/release/changeset';

/**
 * The pull request commands that every project uses. They open each PR ready
 * for review, keep stacked PRs in one linear GitHub stack, and merge in order.
 * See .agents/skills/deliver/references/pull-requests.md.
 */
export const usage = [
  'Usage: bun run pr doctor [--fix]',
  '       bun run pr open --title TEXT --body-file FILE [--base BRANCH] [--force]',
  '       bun run pr body <number> <file>',
  '       bun run pr status <number> [--json]',
  '       bun run pr wait <number> [--timeout 30m] [--json]',
  '       bun run pr failures <number>',
  '       bun run pr sync <number | branch | CL-id>',
  '       bun run pr ready <CL-id> <number>',
  '       bun run pr merge <number> [--timeout 15m]',
].join('\n');

const root = path.resolve(import.meta.dir, '../..');

async function doctor(run: Run, fix: boolean) {
  const problems: Array<string> = [];
  const mise = await readFile(path.join(root, 'mise.toml'), 'utf-8');
  const pinned = pinnedGh(mise);
  const gh = await run(['gh', '--version']);
  const version = ghVersion(gh.out);
  if (!pinned) {
    problems.push('mise.toml does not pin gh. Add a line such as gh = "2.103.3" under [tools].');
  } else if (version !== pinned) {
    problems.push(
      `gh is ${version ?? 'missing'}, but mise.toml pins ${pinned}. Run: mise install, then use mise exec -- bun run pr.`,
    );
  }
  const auth = await run(['gh', 'auth', 'status']);
  if (!auth.ok) {
    problems.push('gh is not signed in. Run: gh auth login');
  }
  const extensions = await run(['gh', 'extension', 'list']);
  const installed = stackExtensionVersion(extensions.out);
  if (installed !== ghStack.version) {
    if (fix) {
      if (installed) {
        await must(run, ['gh', 'extension', 'remove', ghStack.name]);
      }
      await must(run, ['gh', 'extension', 'install', ghStack.repo, '--pin', ghStack.version]);
    } else {
      problems.push(
        `${ghStack.repo} is ${installed ?? 'not installed'}, not ${ghStack.version}. Run: bun run pr doctor --fix`,
      );
    }
  }
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length === 0) {
    console.log(`gh ${version} and ${ghStack.repo} ${ghStack.version} are ready.`);
  }
  return problems.length === 0 ? 0 : 1;
}

async function setBody(run: Run, pr: string, file: string) {
  await must(run, [
    'gh',
    'api',
    '--method',
    'PATCH',
    `repos/{owner}/{repo}/pulls/${pr}`,
    '--field',
    `body=@${file}`,
    '--silent',
  ]);
}

/** Writes a file at a path inside the repository. Tests pass a fake. */
export type Write = (file: string, text: string) => Promise<void>;

async function writeInRepo(file: string, text: string) {
  await Bun.write(path.join(root, file), text);
}

/**
 * Adds a changeset when the branch has none: its bump comes from the
 * conventional title, and its summary is the title. Then commits it.
 */
async function ensureChangeset(
  run: Run,
  write: Write,
  base: string,
  branch: string,
  title: string,
) {
  const added = await must(run, [
    'git',
    'diff',
    '--name-only',
    '--diff-filter=A',
    `origin/${base}...HEAD`,
    '--',
    changesetDir,
  ]);
  if (
    added.split('\n').some((file) => file.endsWith('.md') && path.basename(file) !== 'README.md')
  ) {
    return;
  }
  const file = `${changesetDir}/${branch.replaceAll(/[^\w-]+/gu, '-')}.md`;
  const bump = bumpOf(title);
  await write(file, changesetText(await packageName(root), bump, title));
  await must(run, ['git', 'add', file]);
  await must(run, [
    'git',
    'commit',
    '--quiet',
    '--message',
    `chore(changeset): add a ${bump} changeset for this PR`,
    // Only the changeset. Anything else that is staged stays staged.
    '--',
    file,
  ]);
}

/**
 * Opens a new PR. The release bot opens it when it is set up, so the owner can
 * approve it, and the owner sets the body. Otherwise the user opens it.
 */
async function createPr(
  run: Run,
  clock: Clock,
  pr: { trunk: string; branch: string; base: string; title: string; bodyFile: string },
) {
  const { branch, base, title, bodyFile } = pr;
  if (await openAsBot(run, clock, pr)) {
    const opened = await prWithHead(run, branch);
    if (opened) {
      await setBody(run, String(opened.number), bodyFile);
    }
    return opened;
  }
  const created = await run([
    'gh',
    'pr',
    'create',
    '--base',
    base,
    '--head',
    branch,
    '--title',
    title,
    '--body-file',
    bodyFile,
  ]);
  const opened = await prWithHead(run, branch);
  // A late bot run can open the PR first. Then only the body is left to set.
  if (!created.ok && opened) {
    await setBody(run, String(opened.number), bodyFile);
  } else if (!created.ok) {
    throw new Error(`gh pr create failed: ${created.err || created.out}`);
  }
  return opened;
}

async function open(
  run: Run,
  options: { title?: string; 'body-file'?: string; base?: string; force?: boolean },
  write: Write,
  clock: Clock,
) {
  const { title, 'body-file': bodyFile } = options;
  if (!title || !bodyFile) {
    throw new Error(`open needs --title and --body-file.\n${usage}`);
  }
  const problem = conventionalProblem(title);
  if (problem) {
    throw new Error(`The PR title must be a conventional commit. ${problem}`);
  }
  const trunk = await defaultBranch(run);
  const branch = await must(run, ['git', 'branch', '--show-current']);
  const base = options.base ?? trunk;
  if (!branch || branch === trunk) {
    throw new Error(
      `Switch to the branch for this PR. The current branch is ${branch || 'detached'}.`,
    );
  }
  await ensureChangeset(run, write, base, branch, title);
  // After a rebase the branch needs a forced push. The lease refuses it when someone else pushed.
  const push = [
    'git',
    'push',
    '--set-upstream',
    ...(options.force ? ['--force-with-lease'] : []),
    'origin',
    'HEAD',
  ];
  const pushed = await run(push, { inherit: true });
  if (!pushed.ok) {
    throw new Error(
      options.force
        ? 'The push failed. Read the git output above.'
        : 'The push failed. Read the git output above. When a check failed, fix it. After a rebase of your own branch, run open again with --force.',
    );
  }
  const existing = await prWithHead(run, branch);
  let opened = existing;
  if (existing) {
    await setBody(run, String(existing.number), bodyFile);
  } else {
    opened = await createPr(run, clock, { trunk, branch, base, title, bodyFile });
  }
  if (!opened) {
    throw new Error(`GitHub has no open PR for ${branch} after the create.`);
  }
  if (base === trunk) {
    if (opened.isDraft) {
      await must(run, ['gh', 'pr', 'ready', String(opened.number)]);
    }
  } else {
    await recordForkPoint(run, branch, base);
    const below = await stackChain(base, trunk, (head) => prWithHead(run, head));
    // A PR in the middle keeps the PRs above it in the stack.
    const above = await stackAbove(branch, (head) => prWithBase(run, head));
    await must(
      run,
      ['gh', 'stack', 'link', ...[...below, opened.number, ...above].map(String), '--open'],
      { inherit: true },
    );
  }
  console.log(opened.url);
  return 0;
}

/** Runs `bun run pr <command>`. Returns the exit code. */
export async function runPr(
  args: Array<string>,
  run: Run,
  write: Write = writeInRepo,
  clock: Clock = realClock,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      fix: { type: 'boolean' },
      title: { type: 'string' },
      'body-file': { type: 'string' },
      force: { type: 'boolean' },
      base: { type: 'string' },
      json: { type: 'boolean' },
      timeout: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const timeout = (fallback: string) => duration(values.timeout ?? fallback);
  const print = (status: object) =>
    console.log(values.json ? JSON.stringify(status) : renderStatus(status as PrStatus));
  /** Each command, with the count of arguments it takes. */
  const commands: Record<string, [number, (rest: Array<string>) => Promise<number>]> = {
    doctor: [0, () => doctor(run, values.fix === true)],
    open: [0, () => open(run, values, write, clock)],
    body: [
      2,
      async ([number, file]) => {
        await setBody(run, number, file);
        return 0;
      },
    ],
    status: [
      1,
      async ([number]) => {
        print(await prStatus(run, number));
        return 0;
      },
    ],
    wait: [
      1,
      async ([number]) => {
        const [branch, sha] = await Promise.all([
          run(['git', 'branch', '--show-current']),
          run(['git', 'rev-parse', 'HEAD']),
        ]);
        const local =
          branch.out.trim() && sha.out.trim()
            ? { branch: branch.out.trim(), sha: sha.out.trim() }
            : undefined;
        const options = { timeout: timeout('30m'), interval: 20_000, local };
        const { status, code } = await waitForChecks(run, number, clock, options);
        print({ ...status, timedOut: code === 2 });
        if (code === 2) {
          console.log('Timed out with checks still pending.');
        }
        return code;
      },
    ],
    failures: [
      1,
      async ([number]) => {
        const status = await prStatus(run, number);
        console.log(renderFailures(await failures(run, status.checks)));
        return 0;
      },
    ],
    sync: [1, ([target]) => sync(run, root, target, (options) => open(run, options, write, clock))],
    ready: [2, ([id, number]) => ready(run, root, id, number)],
    merge: [
      1,
      ([number]) => merge(run, number, clock, { timeout: timeout('15m'), interval: 15_000 }),
    ],
  };
  const [command = '', ...rest] = positionals;
  const entry = Object.hasOwn(commands, command) ? commands[command] : undefined;
  if (!entry || entry[0] !== rest.length) {
    throw new Error(usage);
  }
  return await entry[1](rest);
}

const spawn: Run = async (command, options) => {
  const proc = Bun.spawn(command, {
    cwd: root,
    stdout: options?.inherit ? 'inherit' : 'pipe',
    stderr: options?.inherit ? 'inherit' : 'pipe',
  });
  const [out, err, code] = await Promise.all([
    options?.inherit ? '' : new Response(proc.stdout).text(),
    options?.inherit ? '' : new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: code === 0, out, err };
};

if (import.meta.main) {
  try {
    process.exit(await runPr(process.argv.slice(2), spawn));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
