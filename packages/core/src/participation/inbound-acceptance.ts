/**
 * Whether an inbound event was taken in for good, so a talker may confirm
 * receipt upstream only then. A mailbox or a queue that redelivers what is
 * not confirmed loses nothing a crash or a full buffer would otherwise drop.
 *
 * Each event a subscriber is handed carries a ticket. A subscriber that only
 * reads the event accepts it by returning from its handler. One that keeps the
 * event for later, as a chat adapter queues it until it is recorded, takes the
 * ticket and settles it once the event is recorded, or refuses it when the
 * event is dropped. An event never handed to a subscriber has no ticket and
 * nothing waits on it.
 */

export interface AcceptanceTicket {
  accept(): void;
  refuse(reason: unknown): void;
}

interface Ticket extends AcceptanceTicket {
  taken: boolean;
  done: boolean;
}

const tickets = new WeakMap<object, Ticket>();

/** Give `event` a ticket, and the promise that settles with it. A ticket
 *  settles once: later calls do nothing. */
export function openAcceptance(event: object): Promise<void> {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const settled = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A refusal no one awaits is still a settled outcome, not a crash.
  settled.catch(() => {});
  const ticket: Ticket = {
    taken: false,
    done: false,
    accept() {
      if (ticket.done) return;
      ticket.done = true;
      resolve();
    },
    refuse(reason) {
      if (ticket.done) return;
      ticket.done = true;
      reject(reason);
    },
  };
  tickets.set(event, ticket);
  return settled;
}

/** Take `event`'s ticket to settle it later, or null when it has none. The
 *  handler that takes it owns settling it; returning no longer accepts. */
export function takeAcceptance(event: object): AcceptanceTicket | null {
  const ticket = tickets.get(event);
  if (!ticket || ticket.taken || ticket.done) return null;
  ticket.taken = true;
  return ticket;
}

/** Let `copy` stand for `event`: a wrapper that hands its subscriber a copy
 *  of each event calls this, so the subscriber can take the event's ticket
 *  through the copy. Whoever takes it through either one owns it. */
export function shareAcceptance(event: object, copy: object): void {
  const ticket = tickets.get(event);
  if (ticket) tickets.set(copy, ticket);
}

/** Accept `event` unless a handler took its ticket. */
export function acceptUntaken(event: object): void {
  const ticket = tickets.get(event);
  if (ticket && !ticket.taken) ticket.accept();
}

/** Refuse `event`, whoever holds its ticket. */
export function refuseAcceptance(event: object, reason: unknown): void {
  tickets.get(event)?.refuse(reason);
}

/** Why an inbound event was not taken in. Upstream redelivers it. */
export class InboundNotAccepted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundNotAccepted";
  }
}
