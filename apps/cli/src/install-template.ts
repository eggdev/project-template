import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isMap, isSeq, parseDocument } from 'yaml';

import type { Detection } from '@/detect-project';
import { formatFile } from '@/format';
import { gitOrThrow } from '@/git';
import { mergePackageJson } from '@/merge-package-json';
import type { Conflict } from '@/merge-package-json';
import { fingerprint, gitBytes } from '@/review-source';
import { writeEntry } from '@/sync/engine';
import type { SyncFile } from '@/sync/engine';
import { lineagePath, loadClutchSource } from '@/sync/source';

type FileAction = { path: string; action: 'added' | 'replaced' | 'merged' };

/** A file that the project already has with other content. A person keeps, takes or merges it. */
export type InstallDecision = { path: string; rule: 'managed' | 'seed' };
export type InstallAnswers = { keep: Array<string>; take: Array<string>; merge: Array<string> };

type Merged = { content: string; conflicts: Array<Conflict> };

/** Objects merge key by key, and lists keep the items of both. The template wins a clash. */
function mergeJson(project: string, template: string, keep?: (path: string) => boolean): Merged {
  const merged = mergePackageJson(JSON.parse(project), JSON.parse(template), keep);
  return { content: `${JSON.stringify(merged.manifest, null, 2)}\n`, conflicts: merged.conflicts };
}

/** How the merge rule combines the project's copy of a file with the template's, by file name. */
/** Adds the template's lines that the project lacks, for line-based files such as .gitignore. */
function mergeLines(project: string, template: string): Merged {
  const own = new Set(project.split('\n').map((line) => line.trim()));
  const missing = template
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !own.has(line));
  const content = missing.length
    ? `${project}\n\n# From Clutch\n${missing.join('\n')}\n`
    : `${project}\n`;
  return { content, conflicts: [] };
}

export const mergers: Record<
  string,
  (project: string, template: string, keep?: (path: string) => boolean) => Merged
> = {
  'package.json': mergeJson,
  // Agent hook configs. A project keeps its own hooks and settings, and gains the template's hooks.
  'settings.json': mergeJson,
  'hooks.json': mergeJson,
  '.gitignore': mergeLines,
  '.gitattributes': mergeLines,
};

const registryPath = 'docs/contributing/architecture/primitives.yaml';

/**
 * Removes each primitive from the copied registry when the project has no
 * file under any of its `code` roots. The template registers parts that stay
 * in the template, such as this installer.
 */
async function pruneRegistry(root: string, files: Array<string>) {
  const file = path.join(root, registryPath);
  const doc = parseDocument(await readFile(file, 'utf-8'));
  const primitives = doc.get('primitives');
  if (!isSeq(primitives)) {
    return;
  }
  const present = (code: string) => files.some((name) => name.startsWith(code));
  primitives.items = primitives.items.filter((item) => {
    const code = isMap(item) ? item.get('code') : undefined;
    return !isSeq(code) || code.items.some((entry) => present(String(entry)));
  });
  await writeFile(file, doc.toString());
}

/** The changelog that a new project starts with: a title and no entries. */
export const freshChangelog = { path: 'CHANGELOG.md', text: '# Changelog\n' };

export const branch = 'template/install';
export const manifestPath = '.template-install/manifest.json';

/** The files that `rev` tracks. */
async function listFiles(cwd: string, rev: string) {
  const out = await gitOrThrow(cwd, 'ls-tree', '-r', '--name-only', rev);
  return out.split('\n').filter(Boolean);
}

/** The project's copy of each file at `rev`, with the same fingerprint as Clutch's copy. */
async function projectFiles(root: string, rev: string) {
  const listing = await gitBytes(root, ['ls-tree', '-rz', rev]);
  const modes = new Map<string, string>();
  for (const record of listing.toString().split('\0').filter(Boolean)) {
    const [header, file] = record.split('\t');
    const [mode, type] = header.split(' ');
    if (type === 'blob') {
      modes.set(file, mode);
    }
  }
  return {
    has: (file: string) => modes.has(file),
    read: async (file: string) => {
      const mode = modes.get(file);
      if (!mode) {
        return null;
      }
      const content = await gitBytes(root, ['show', `${rev}:${file}`]);
      return { content, hash: fingerprint(mode, content) };
    },
  };
}

const end = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

/** Clutch's copy and the project's copy of a seed file, between conflict markers, for a person to resolve. */
function withMarkers(mine: Buffer, theirs: Buffer) {
  return `<<<<<<< project\n${end(mine.toString())}=======\n${end(theirs.toString())}>>>>>>> clutch\n`;
}

type Planned = {
  writes: Map<string, SyncFile>;
  merges: Array<string>;
  marked: Map<string, string>;
  kept: Record<string, string>;
  files: Array<FileAction>;
  decisions: Array<InstallDecision>;
};

async function planInstall(
  source: Awaited<ReturnType<typeof loadClutchSource>>,
  project: Awaited<ReturnType<typeof projectFiles>>,
  answers: InstallAnswers,
): Promise<Planned> {
  const planned: Planned = {
    writes: new Map(),
    merges: [],
    marked: new Map(),
    kept: {},
    files: [],
    decisions: [],
  };
  for (const [file] of source.merge) {
    if (project.has(file)) {
      planned.merges.push(file);
      planned.files.push({ path: file, action: 'merged' });
    } else {
      planned.writes.set(file, source.merge.get(file) as SyncFile);
      planned.files.push({ path: file, action: 'added' });
    }
  }
  for (const rule of ['managed', 'seed'] as const) {
    const files = rule === 'managed' ? source.managed.files : source.seed;
    for (const [file, theirs] of files) {
      const mine = await project.read(file);
      if (!mine) {
        planned.writes.set(file, theirs);
        planned.files.push({ path: file, action: 'added' });
      } else if (mine.hash === theirs.hash) {
        continue;
      } else if (answers.take.includes(file)) {
        planned.writes.set(file, theirs);
        planned.files.push({ path: file, action: 'replaced' });
      } else if (answers.merge.includes(file) && rule === 'seed') {
        planned.marked.set(file, withMarkers(mine.content, theirs.content));
        planned.files.push({ path: file, action: 'merged' });
      } else if (answers.keep.includes(file)) {
        if (rule === 'managed') {
          planned.kept[file] = theirs.hash;
        }
      } else {
        planned.decisions.push({ path: file, rule });
      }
    }
  }
  return planned;
}

function checkAnswers(
  answers: InstallAnswers,
  decisions: Array<InstallDecision>,
  planned: Planned,
) {
  const asked = new Set([
    ...decisions.map((item) => item.path),
    ...planned.files.map((item) => item.path),
    ...Object.keys(planned.kept),
  ]);
  for (const file of [...answers.keep, ...answers.take, ...answers.merge]) {
    if (!asked.has(file)) {
      throw new Error(
        `${file} needs no decision. Pass --keep, --take or --merge only for the files that install lists.`,
      );
    }
  }
}

/**
 * Plans the install of Clutch into an existing project from its default
 * branch. A file the project already has with other content needs a person's
 * answer. Until each one has an answer, nothing changes and no branch exists.
 * With every answer, it switches to a new branch, writes the files, the
 * manifest and the lineage, and commits.
 */
export async function installTemplate(options: {
  project: Extract<Detection, { kind: 'existing' }>;
  template: string;
  answers?: Partial<InstallAnswers>;
}) {
  const { project, template } = options;
  const answers: InstallAnswers = { keep: [], take: [], merge: [], ...options.answers };
  const commit = await gitOrThrow(template, 'rev-parse', 'HEAD');
  const source = await loadClutchSource(template, commit);
  const mine = await projectFiles(project.root, project.defaultBranch);
  const planned = await planInstall(source, mine, answers);
  checkAnswers(answers, planned.decisions, planned);
  if (planned.decisions.length > 0) {
    return { status: 'decisions' as const, decisions: planned.decisions };
  }
  for (const name of planned.merges) {
    if (!Object.hasOwn(mergers, path.basename(name))) {
      throw new Error(
        `clutch.files.yaml: the merge rule supports ${Object.keys(mergers).join(' and ')}, not ${name}`,
      );
    }
  }

  const { root } = project;
  await gitOrThrow(root, 'switch', '--quiet', '--create', branch, project.defaultBranch);
  for (const [name, file] of planned.writes) {
    await writeEntry(root, name, file);
  }
  for (const [name, content] of planned.marked) {
    await writeFile(path.join(root, name), content);
  }
  const conflicts: Array<Conflict & { file: string }> = [];
  for (const name of planned.merges) {
    const merged = mergers[path.basename(name)](
      await gitOrThrow(root, 'show', `${project.defaultBranch}:${name}`),
      (source.merge.get(name) as SyncFile).content.toString(),
    );
    await writeFile(path.join(root, name), merged.content);
    if (path.basename(name) === 'package.json') {
      await formatFile(root, name);
    }
    conflicts.push(...merged.conflicts.map((conflict) => ({ file: name, ...conflict })));
  }

  // A project keeps its own release history, so it starts a fresh changelog.
  if (!mine.has(freshChangelog.path)) {
    await writeFile(path.join(root, freshChangelog.path), freshChangelog.text);
    planned.files.push({ path: freshChangelog.path, action: 'added' });
  }
  const copied = [...planned.writes.keys()];
  if (copied.includes(registryPath)) {
    const existing = await listFiles(root, project.defaultBranch);
    await pruneRegistry(root, [...existing, ...copied]);
  }

  const base = {
    branch: project.defaultBranch,
    commit: await gitOrThrow(root, 'rev-parse', project.defaultBranch),
  };
  const markers = [...planned.marked.keys()];
  const manifest = {
    template: { commit },
    base,
    stage: 'survey',
    files: planned.files,
    conflicts,
    ...(markers.length > 0 ? { markers } : {}),
  };
  await mkdir(path.join(root, path.dirname(manifestPath)), { recursive: true });
  await writeFile(path.join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  const lineage = {
    schemaVersion: 1,
    templateRepo: '',
    templateCommit: commit,
    ...(source.release ? { release: source.release } : {}),
    files: Object.fromEntries([...source.managed.files].map(([name, file]) => [name, file.hash])),
    ...(Object.keys(planned.kept).length > 0 ? { kept: planned.kept } : {}),
  };
  await mkdir(path.join(root, path.dirname(lineagePath)), { recursive: true });
  await writeFile(path.join(root, lineagePath), `${JSON.stringify(lineage, null, 2)}\n`);
  await gitOrThrow(root, 'add', '--all');
  await gitOrThrow(root, 'commit', '--quiet', '--message', 'Install template: copy files');
  return { status: 'installed' as const, manifest };
}
