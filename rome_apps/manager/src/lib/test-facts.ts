import type { Fact, NewFact } from "./facts.js";

/**
 * Builds fact lists for the pure-logic tests. Everything the fold and the
 * reconcile need is a value, so no test here touches a database.
 */
export class LedgerBuilder {
  private seq = 0;
  private clock: number;
  readonly facts: Fact[] = [];

  constructor(startMs = Date.parse("2026-09-08T09:00:00.000Z")) {
    this.clock = startMs;
  }

  /** Append one fact, `minutesLater` after the previous one. */
  add(fact: NewFact, minutesLater = 1): this {
    this.seq += 1;
    this.clock += minutesLater * 60_000;
    this.facts.push({
      ...fact,
      seq: this.seq,
      id: `f-${this.seq}`,
      createdAt: new Date(this.clock),
    } as Fact);
    return this;
  }

  /** The moment just after the last fact, for a snapshot's `now`. */
  now(minutesLater = 1): Date {
    return new Date(this.clock + minutesLater * 60_000);
  }
}
