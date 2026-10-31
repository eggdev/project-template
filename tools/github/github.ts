import type { Run } from '@tools/github/stack';

/** Runs a command and returns its trimmed output, or throws with its error. */
export async function must(run: Run, command: Array<string>, options?: { inherit?: boolean }) {
  const result = await run(command, options);
  if (!result.ok) {
    throw new Error(`${command.join(' ')} failed: ${result.err || result.out}`);
  }
  return result.out.trim();
}

export function defaultBranch(run: Run) {
  return must(run, [
    'gh',
    'repo',
    'view',
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name',
  ]);
}

/** The open PR whose head is `branch`, with its base. */
export async function prWithHead(run: Run, branch: string) {
  const out = await must(run, [
    'gh',
    'pr',
    'list',
    '--state',
    'open',
    '--head',
    branch,
    '--json',
    'number,baseRefName,url,isDraft',
  ]);
  const [found] = JSON.parse(out || '[]') as Array<{
    number: number;
    baseRefName: string;
    url: string;
    isDraft: boolean;
  }>;
  return (
    found && {
      number: found.number,
      base: found.baseRefName,
      url: found.url,
      isDraft: found.isDraft,
    }
  );
}

/** The open PR whose base is `branch`, the one stacked on it. */
export async function prWithBase(run: Run, branch: string) {
  const out = await must(run, [
    'gh',
    'pr',
    'list',
    '--state',
    'open',
    '--base',
    branch,
    '--json',
    'number,headRefName',
  ]);
  const [found] = JSON.parse(out || '[]') as Array<{ number: number; headRefName: string }>;
  return found && { number: found.number, head: found.headRefName };
}

/** Waits and tells the time. Tests pass a clock that never sleeps. */
export type Clock = { sleep: (ms: number) => Promise<void>; now: () => number };

export const realClock: Clock = { sleep: (ms) => Bun.sleep(ms), now: () => Date.now() };

/** `30m`, `90s` or `2h` in milliseconds. */
export function duration(text: string) {
  const match = /^(\d+)(s|m|h)$/u.exec(text);
  if (!match) {
    throw new Error(`A duration is a number and s, m or h, such as 30m. Got ${text}.`);
  }
  return Number(match[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 's' | 'm' | 'h'];
}
