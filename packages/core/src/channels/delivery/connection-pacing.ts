import type { Connection, ConnectionId } from "../../connections/types.js";
import type { Clock } from "../../lib/clock.js";
import { Pacer } from "./pacer.js";
import type { ReplyStreamingSwitch } from "./streaming-switch.js";

/**
 * One Pacer per Connection whose talker declares reply delivery, shared by
 * the Connection's streamed replies and its ordinary sends while reply
 * streaming is on. A Connection whose talker declares none has no pacer, and
 * its writes are never held. A pacer outlives the Connection's credential
 * epochs, so a relock does not reset the budget. Its budget is the one the
 * talker declares, read when the pacer is first needed.
 */
export class ConnectionPacing {
  private readonly pacers = new Map<ConnectionId, Pacer>();

  constructor(
    private readonly clock: Clock,
    private readonly streaming: ReplyStreamingSwitch,
  ) {}

  /** The Connection's pacer, or null when its talker declares no reply
   *  delivery or is not live. */
  pacerFor(connection: Connection): Pacer | null {
    const known = this.pacers.get(connection.id);
    if (known) return known;
    const budget = connection.withTalker((talker) => talker.replyDelivery?.capabilities.budget);
    if (!budget) return null;
    const pacer = new Pacer(budget, this.clock);
    this.pacers.set(connection.id, pacer);
    return pacer;
  }

  /**
   * Runs `write` in the Connection's pacer. It runs at once, as it would with
   * no pacing, when reply streaming is off or the Connection has no pacer.
   */
  async run<T>(connection: Connection, conversation: string, write: () => Promise<T>): Promise<T> {
    if (!(await this.streaming())) return write();
    return this.pacerFor(connection)?.run(conversation, write) ?? write();
  }
}
