import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import * as prompts from '@clack/prompts';
import { Document } from 'yaml';

import { capabilityRegistry, clutchCheckout } from '@/clutch-checkout';
import { nextBaseline, writeBaseline } from '@/doctor/baseline';
import { detect } from '@/doctor/detect';
import { formatText } from '@/format';
import { git, gitOrThrow } from '@/git';
import { adoptedLineage } from '@/init/adopt';
import { freshChangelog } from '@/install-template';
import { renderTracker } from '@/issues/render';
import { latestRelease } from '@/release';
import { lineagePath, loadClutchSource } from '@/sync/source';

const trackerReadme = `# Tracker

One Markdown file per issue lives in \`issues/\`. \`TRACKER.md\` is generated from
them by \`clutch issues --write\`, which the release workflow runs on the default
branch. Edit and commit the issue files, never \`TRACKER.md\`.
File a new issue with \`clutch issues new\`. See
\`.agents/skills/deliver/references/commands.md\` for every repeatable command.
`;

/** The owner/name of the Clutch checkout's origin remote. */
/**
 * The seed files that the managed tooling reads. Install writes every seed,
 * and sync never writes one, so init writes these for a project that adopts
 * Clutch without install. The Risk workflow and `clutch risk` read risk.yaml.
 */
const toolingSeeds = ['.clutch/risk.yaml', '.changeset/README.md'];

async function templateRepo(template: string) {
  const url = await git(template, 'remote', 'get-url', 'origin');
  const match = /[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(url.out);
  return match ? match[1] : 'eggdev/clutch';
}

async function write(root: string, file: string, content: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

/** `clutch.yaml` for a new adopter. A core gap gets a placeholder waiver that the owner replaces. */
function configText(input: {
  project: string;
  repo: string;
  mode: string;
  decisions: Record<string, unknown>;
}) {
  const doc = new Document({
    schemaVersion: 1,
    project: input.project,
    template: { repo: input.repo, mode: input.mode },
    capabilities: input.decisions,
  });
  doc.commentBefore =
    ' How this repository adopts Clutch. Replace each "Decide during adoption." waiver\n with a real reason and an issue, or adopt the capability. See clutch doctor --check.';
  return doc.toString();
}

async function run(args: Array<string>, cwd: string, template: string): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      root: { type: 'string' },
      mode: { type: 'string', default: 'sync' },
      adopt: { type: 'boolean' },
      yes: { type: 'boolean' },
    },
  });
  if (values.mode !== 'sync' && values.mode !== 'doctor') {
    throw new Error('--mode is sync or doctor.');
  }
  const root = await gitOrThrow(
    path.resolve(cwd, values.root ?? '.'),
    'rev-parse',
    '--show-toplevel',
  );
  if (await Bun.file(path.join(root, 'clutch.yaml')).exists()) {
    throw new Error(`${root} already has clutch.yaml. Use clutch sync or clutch doctor instead.`);
  }
  if (!values.yes) {
    const go = await prompts.confirm({ message: `Adopt Clutch in ${root}?` });
    if (go !== true) {
      console.log('Nothing changed.');
      return 0;
    }
  }
  const release = await latestRelease(template);
  const registry = await capabilityRegistry();
  const entries = registry.capabilities ?? [];
  const detections = await detect(root, entries);
  const byId = new Map(detections.map((item) => [item.id, item.status]));
  const decisions: Record<string, unknown> = {};
  for (const entry of entries) {
    const status = byId.get(entry.id);
    if (status === 'present') {
      decisions[entry.id] = 'adopted';
    } else if (entry.level === 'core' && status !== 'unknown') {
      decisions[entry.id] = { status: 'waived', reason: 'Decide during adoption.' };
    }
  }
  await write(
    root,
    'clutch.yaml',
    configText({
      project: path.basename(root),
      repo: await templateRepo(template),
      mode: values.mode,
      decisions,
    }),
  );
  const written = ['clutch.yaml'];
  const source = values.mode === 'sync' ? await loadClutchSource(template, release) : undefined;
  for (const file of toolingSeeds) {
    const seed = source?.seed.get(file);
    if (seed && !(await Bun.file(path.join(root, file)).exists())) {
      await write(root, file, seed.content.toString());
      written.push(file);
    }
  }
  if (source && values.adopt) {
    const files = await adoptedLineage(root, template, source.managed);
    const lineage = {
      schemaVersion: 1,
      templateRepo: await templateRepo(template),
      templateCommit: source.commit,
      release,
      files,
    };
    await write(root, lineagePath, `${JSON.stringify(lineage, null, 2)}\n`);
    written.push(lineagePath);
  }
  if (!(await Bun.file(path.join(root, freshChangelog.path)).exists())) {
    await write(root, freshChangelog.path, freshChangelog.text);
    written.push(freshChangelog.path);
  }
  await write(root, '.clutch/README.md', trackerReadme);
  await mkdir(path.join(root, '.clutch/issues'), { recursive: true });
  await write(root, '.clutch/issues/.gitkeep', '');
  await write(
    root,
    '.clutch/TRACKER.md',
    await formatText(root, '.clutch/TRACKER.md', `${renderTracker([])}\n`),
  );
  await writeBaseline(root, nextBaseline(detections));
  written.push(
    '.clutch/README.md',
    '.clutch/issues/',
    '.clutch/TRACKER.md',
    '.clutch/doctor-baseline.json',
  );
  const waived = Object.values(decisions).filter((value) => typeof value === 'object').length;
  console.log(
    [
      `Clutch is adopted in ${root} (mode ${values.mode}, Clutch ${release}). Nothing is committed.`,
      `Wrote: ${written.join(', ')}.`,
      `${waived} core gaps have the placeholder waiver "Decide during adoption." Replace each one with a reason and an issue.`,
      'Next: make a branch, review the files, run clutch doctor --check, then commit and open a PR.',
    ].join('\n'),
  );
  return 0;
}

/** `clutch init`: adopts Clutch in a repository. */
export async function initCommand(
  args: Array<string>,
  cwd: string,
  checkout?: string,
): Promise<number> {
  try {
    return await run(args, cwd, checkout ?? (await clutchCheckout()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
