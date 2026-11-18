/**
 * Turns the Agent SDK's `total_cost_usd` into each result's own cost.
 *
 * The SDK reports a running total for the whole `query()` call: every result
 * in a streaming-input session carries the spend so far, a resumed or forked
 * session starts from the total its transcript saved, and `/clear` restarts
 * it at zero. Rome records cost per turn and sums turns, so it records the
 * difference from the previous result instead.
 */
export class RunningCost {
  private last: number | undefined;

  /** `fresh` is true when the query starts a thread the CLI has never seen,
   *  so its running total starts at zero. A resumed or forked thread starts
   *  from a total Rome cannot read. */
  constructor(fresh: boolean) {
    this.last = fresh ? 0 : undefined;
  }

  /** This result's own cost, from the running total it reports. Undefined
   *  when the total is missing, or when it is the first total of a resumed
   *  thread and so includes turns already recorded. */
  next(total: number | undefined): number | undefined {
    if (total === undefined) return undefined;
    const last = this.last;
    this.last = total;
    if (last === undefined) return undefined;
    // A smaller total means the SDK restarted its count.
    return total >= last ? total - last : total;
  }
}
