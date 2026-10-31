import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { formatFile, formatText } from '@/format';
import { git } from '@/git';
import { newIssue } from '@/issues/new';
import { nextIssue } from '@/issues/next';
import { frontmatter, ownerPattern, readIssues, statuses } from '@/issues/parse';
import type { Issue, IssueError } from '@/issues/parse';
import { renderTracker, trackerFile } from '@/issues/render';

const usage =
  'Usage: clutch issues [--write | --check [--fresh]] [--json]\n       clutch issues next [--stack] [--json]\n       clutch issues set <id> <status> [--pr URL] [--owner NAME]\n       clutch issues new --phase P --title TEXT [--depends CL-NNN,...] [--owner NAME] [--range CL-NNN..CL-NNN] [--json]';

/** The repository that holds `cwd`, or `cwd` when it is not in one. */
async function repoRoot(cwd: string) {
  const top = await git(cwd, 'rev-parse', '--show-toplevel');
  return top.ok ? top.out : cwd;
}

function describe(error: IssueError) {
  return [error.file, error.field, error.message].filter(Boolean).join(': ');
}

/** The tracker as `clutch issues --write` writes it. */
function tracker(root: string, issues: Array<Issue>) {
  return formatText(root, trackerFile, `${renderTracker(issues)}\n`);
}

async function readTracker(root: string) {
  try {
    return await readFile(path.join(root, trackerFile), 'utf-8');
  } catch {
    return '';
  }
}

/** Replaces the value of each top-level `key:` line in the frontmatter of `text`. */
function setFields(text: string, values: Record<string, string>) {
  const block = frontmatter(text);
  if (!block) {
    throw new Error('The issue file has no frontmatter.');
  }
  let { yaml } = block;
  for (const [key, value] of Object.entries(values)) {
    yaml = yaml.replace(new RegExp(`^${key}:.*$`, 'mu'), `${key}: ${value}`);
  }
  return `---\n${yaml}---\n${text.slice(block.end)}`;
}

async function setIssue(
  root: string,
  issues: Array<Issue>,
  positionals: Array<string>,
  options: { pr?: string; owner?: string },
) {
  const [id, status] = positionals;
  const issue = issues.find((candidate) => candidate.id === id);
  if (!issue) {
    throw new Error(`No issue ${id} in .clutch/issues.`);
  }
  if (!(statuses as ReadonlyArray<string>).includes(status)) {
    throw new Error(`Status must be one of ${statuses.join(', ')}.`);
  }
  if (options.owner !== undefined && !ownerPattern.test(options.owner)) {
    throw new Error(`Owner must be agent, brendan or an agent name. Got ${options.owner}.`);
  }
  const values: Record<string, string> = { status };
  if (options.pr !== undefined) {
    values.pr = `'${options.pr}'`;
  }
  if (options.owner !== undefined) {
    values.owner = options.owner;
  }
  const file = path.join(root, issue.file);
  await writeFile(file, setFields(await readFile(file, 'utf-8'), values));
  await formatFile(root, issue.file);
}

function printList(issues: Array<Issue>) {
  for (const issue of issues) {
    console.log(
      `${issue.id.padEnd(7)} ${issue.status.padEnd(11)} ${issue.phase.padEnd(5)} ${issue.title}`,
    );
  }
}

/**
 * `--check` passes when every issue file is valid, which `run` makes sure of
 * first. The release generates the tracker on the default branch, so a pull
 * request never has to bring it up to date. `--fresh` also requires the
 * committed tracker to match the issue files.
 */
async function checkTracker(root: string, issues: Array<Issue>, fresh: boolean) {
  if (!fresh) {
    return 0;
  }
  const current = (await readTracker(root)) === (await tracker(root, issues));
  if (!current) {
    console.error(`${trackerFile} is stale. Run: mise exec -- bun run clutch issues --write`);
  }
  return current ? 0 : 2;
}

async function run(args: Array<string>, cwd: string): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      write: { type: 'boolean' },
      check: { type: 'boolean' },
      fresh: { type: 'boolean' },
      json: { type: 'boolean' },
      stack: { type: 'boolean' },
      pr: { type: 'string' },
      owner: { type: 'string' },
      phase: { type: 'string' },
      title: { type: 'string' },
      depends: { type: 'string' },
      range: { type: 'string' },
    },
  });
  const [action, ...rest] = positionals;
  const root = await repoRoot(cwd);
  const { issues, errors } = await readIssues(root);
  if (errors.length > 0) {
    if (values.json) {
      console.log(JSON.stringify({ schemaVersion: 1, issues, errors }));
    } else {
      console.error(errors.map(describe).join('\n'));
    }
    return 1;
  }

  if (action === 'next' && rest.length === 0) {
    const issue = nextIssue(issues, { stack: values.stack });
    if (values.json) {
      console.log(JSON.stringify({ schemaVersion: 1, issue: issue ?? null }));
    } else {
      console.log(issue ? `${issue.id}  ${issue.title}\n${issue.file}` : 'No unblocked issue.');
    }
    return issue ? 0 : 1;
  }
  if (action === 'new' && rest.length === 0) {
    const created = await newIssue(root, values);
    await formatFile(root, created.file);
    console.log(
      values.json
        ? JSON.stringify({ schemaVersion: 1, ...created })
        : `${created.id}  ${created.file}`,
    );
    return 0;
  }
  if (action === 'set' && rest.length === 2) {
    await setIssue(root, issues, rest, values);
    console.log(`${rest[0]} is ${rest[1]}.`);
    return 0;
  }
  if (action !== undefined) {
    throw new Error(usage);
  }

  if (values.check) {
    return checkTracker(root, issues, values.fresh === true);
  }
  if (values.write) {
    await writeFile(path.join(root, trackerFile), await tracker(root, issues));
  }
  if (values.json) {
    console.log(JSON.stringify({ schemaVersion: 1, issues, errors }));
  } else {
    printList(issues);
  }
  return 0;
}

/** `clutch issues`: list, pick and update the issues in `.clutch/issues`. */
export async function issuesCommand(args: Array<string>, cwd: string): Promise<number> {
  try {
    return await run(args, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.includes('--json')) {
      console.log(JSON.stringify({ schemaVersion: 1, status: 'error', message }));
    } else {
      console.error(message);
    }
    return 1;
  }
}
