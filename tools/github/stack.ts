/** The GitHub CLI extension that manages stacked pull requests, at the pinned release. */
export const ghStack = { repo: 'github/gh-stack', name: 'gh-stack', version: 'v0.3.0' };

export type Result = { ok: boolean; out: string; err: string };

/**
 * Runs a command. `inherit` shows its output as it runs, for a push that runs
 * the hooks. `env` adds variables, such as another `GH_TOKEN` for one call.
 */
export type Run = (
  command: Array<string>,
  options?: { inherit?: boolean; env?: Record<string, string> },
) => Promise<Result>;

/** The `gh` version that `mise.toml` pins, such as `2.103.3`. */
export function pinnedGh(miseToml: string) {
  return /^\s*gh\s*=\s*"([^"]+)"/mu.exec(miseToml)?.[1];
}

/** The version in the output of `gh --version`. */
export function ghVersion(output: string) {
  return /gh version (\d+\.\d+\.\d+)/u.exec(output)?.[1];
}

/** The installed version of the stack extension, from `gh extension list`. */
export function stackExtensionVersion(list: string) {
  const line = list.split('\n').find((row) => row.includes(ghStack.repo));
  return line?.split('\t').at(-1)?.trim();
}

export type OpenPr = { number: number; base: string };

/**
 * The open PRs above `head`, from the one just above it to the top. Each one's
 * base is the head of the one below it. `gh stack link` needs the whole stack:
 * linking only the PRs below would remove the ones above from it.
 */
export async function stackAbove(
  head: string,
  prWithBase: (branch: string) => Promise<{ number: number; head: string } | undefined>,
  found: Array<number> = [],
): Promise<Array<number>> {
  if (found.length >= 20) {
    throw new Error(`The stack is deeper than 20 PRs above ${head}. Check the PR bases.`);
  }
  const pr = await prWithBase(head);
  return pr ? stackAbove(pr.head, prWithBase, [...found, pr.number]) : found;
}

/**
 * The open PRs under `base`, from the bottom of the stack up. Each one's head
 * is the base of the one above it. The chain ends at the default branch.
 */
export async function stackChain(
  base: string,
  defaultBranch: string,
  prWithHead: (branch: string) => Promise<OpenPr | undefined>,
  above: Array<number> = [],
): Promise<Array<number>> {
  if (base === defaultBranch) {
    return above;
  }
  if (above.length >= 20) {
    throw new Error(`The stack is deeper than 20 PRs at ${base}. Check the PR bases.`);
  }
  const pr = await prWithHead(base);
  if (!pr) {
    throw new Error(
      `No open PR has the head ${base}. Open that PR first, or pass --base ${defaultBranch}.`,
    );
  }
  return stackChain(pr.base, defaultBranch, prWithHead, [pr.number, ...above]);
}
