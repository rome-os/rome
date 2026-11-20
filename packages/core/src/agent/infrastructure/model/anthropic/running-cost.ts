/**
 * Turns the Agent SDK's `total_cost_usd` into each result's own cost.
 *
 * The SDK reports a running total for the whole `query()` call: every result
 * in a streaming-input session carries the spend so far, a resumed or forked
 * session starts from the total its transcript saved, and `/clear` restarts
 * it at zero. Rome records cost per turn and sums turns, so it records the
 * difference from the previous total instead. A result whose own cost can't
 * be told apart from earlier turns gets none, and the caller prices it from
 * its tokens.
 */
export class RunningCost {
  /** The total the next difference is taken from. Undefined until a total
   *  Rome can trust has been seen. */
  private last: number | undefined;

  /** `fresh` is true when the query starts a thread the CLI has never seen,
   *  so its running total starts at zero. A resumed or forked thread starts
   *  from a total Rome cannot read. */
  constructor(fresh: boolean) {
    this.last = fresh ? 0 : undefined;
  }

  /** This result's own cost, from the running total it reports. Undefined
   *  when the result has no total, when its total is the zero the SDK puts on
   *  an empty or failed result, or when no earlier total is known. The total
   *  after any of these only sets where the next difference starts. */
  next(total: number | undefined): number | undefined {
    if (total === undefined || (total === 0 && this.last !== 0)) {
      this.last = undefined;
      return undefined;
    }
    const last = this.last;
    this.last = total;
    if (last === undefined) return undefined;
    // A smaller total means the SDK restarted its count, as `/clear` does.
    // A restart followed by a turn that ends above the old total looks like
    // an ordinary turn, so this undercounts that turn. Rome never sends
    // `/clear` itself.
    return total >= last ? total - last : total;
  }
}
