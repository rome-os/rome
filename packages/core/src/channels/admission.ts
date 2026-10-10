/**
 * Admission: whether a channel's subscribers may hear a message that arrived
 * on one of its Connections (pairing, for the channels that pair). It runs
 * once per message, before any subscriber hears it, which is what gives the
 * inbound port rule R1.
 */

import type { ChannelMessage } from "@rome-os/app-runtime";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import { createLogger } from "../logger.js";

const log = createLogger("channel-admission");

/** Decides whether subscribers may hear a message from one Connection. */
export type Admission = (
  connectionId: string,
  service: string,
  message: ChannelMessage,
) => Promise<boolean>;

/** How long one admission may hold its conversation. Pairing admission is a
 *  few database reads, so fifteen seconds means the database is stuck. */
export const ADMISSION_TIMEOUT_MS = 15_000;

export interface OrderedAdmissionOptions {
  admissionTimeoutMs?: number;
}

/**
 * Admits a Connection's messages one at a time per conversation.
 *
 * Admission awaits the database, and pooled queries can finish in either
 * order. Each message's admission waits for the previous one in its
 * conversation, and an admitted message is handed on before the next
 * admission begins, so subscribers hear a conversation in arrival order. An
 * admission therefore holds up its conversation's next message for as long as
 * it runs; pairing admission waits only on its reads and sends its replies in
 * the background. An admission that runs past the timeout fails closed: the
 * message is not admitted, and the next one proceeds in order.
 */
export class OrderedAdmission {
  private readonly admissions = new KeyedMutex();

  constructor(
    private readonly admit?: Admission,
    private readonly options: OrderedAdmissionOptions = {},
  ) {}

  /** Hands `message` to `hear` once it is admitted. Resolves when `hear` has
   *  finished; the conversation is released as soon as `hear` starts. */
  async deliver(
    connection: { id: string; service: string },
    message: ChannelMessage,
    hear: (message: ChannelMessage) => Promise<unknown>,
  ): Promise<void> {
    const admit = this.admit;
    if (!admit) {
      await hear(message);
      return;
    }
    const key = `${connection.id}\0${message.conversationId}`;
    // The handlers' completion is returned inside an object so the
    // conversation is released once they start, not once they finish.
    const started = await this.admissions.runExclusive(key, async () => {
      if (!(await this.admitWithin(connection, message, admit))) return null;
      return { handled: hear(message) };
    });
    if (started) await started.handled;
  }

  private async admitWithin(
    connection: { id: string; service: string },
    message: ChannelMessage,
    admit: Admission,
  ): Promise<boolean> {
    const timeoutMs = this.options.admissionTimeoutMs ?? ADMISSION_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        log.warn("admission timed out; message not admitted", {
          connectionId: connection.id,
          conversationId: message.conversationId,
          messageId: message.messageId,
          timeoutMs,
        });
        resolve(false);
      }, timeoutMs);
    });
    try {
      return await Promise.race([admit(connection.id, connection.service, message), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}
