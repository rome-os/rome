// The shape a goal's check files export. A goal is a folder `goals/<goal>/`
// whose `checks/*.ts` files each default-export a Check or an array of them,
// counted against `baseline.json` by scripts/goals/check.ts.

export interface Check {
  /** Unique within its goal. The key in baseline.json. Lower-case words joined by hyphens. */
  name: string;
  /** One sentence saying what must be true, shown when the check fails. */
  description: string;
  /**
   * Every current violation, one line each, usually "path: what is wrong".
   * Reads only the tree under `ctx.root`, the repository's absolute path: no
   * network, no git, no environment.
   */
  violations(ctx: { root: string }): string[] | Promise<string[]>;
}
