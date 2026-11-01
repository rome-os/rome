// An email peer: a mail provider in memory, as Rome Cloud Mail answers, with
// one person who writes to Rome's mailbox. Each thread is a conversation the
// person sees. Nothing here is recorded from the provider yet, so every
// answer is synthetic.

import { createHmac } from "node:crypto";
import type {
  MailProvider,
  RomeMailEvent,
  RomeMailListItem,
} from "../../../lib/rome-cloud-mail.js";
import type { PeopleRepository } from "../../../db/repositories/people.js";
import type { SettingsRepository } from "../../../db/repositories/settings.js";
import { EmailAdapter } from "../../../channels/email.js";
import { MessageStore, type VisibleMessage } from "./peer.js";

export const EMAIL_MAILBOX = "rome@example.com";
export const EMAIL_PERSON = "alice@example.com";
const SECRET = "fixture-secret";

export class EmailPeer {
  private readonly store = new MessageStore();
  private readonly threads = new Map<string, RomeMailListItem[]>();
  private nextId = 1;
  private nextThread = 1;
  /** Rome's mail adapter, wired to this provider. */
  readonly adapter: EmailAdapter;

  constructor() {
    this.adapter = new EmailAdapter({
      provider: this.provider(),
      settingsRepo: {
        get: async () => ({ enabled: true, guardianEmail: "guardian@example.com" }),
      } as unknown as SettingsRepository,
      peopleRepo: {
        byAccount: async () => null,
        isDismissed: async () => false,
        byBondLevel: async () => [],
      } as unknown as PeopleRepository,
      config: { address: EMAIL_MAILBOX, inboundSecret: SECRET },
    });
  }

  /** What the person sees in thread `threadId`. */
  visible(threadId: string): VisibleMessage[] {
    return this.store.visible(threadId);
  }

  /** The person writes in thread `threadId`, a new one when none is named,
   *  and the provider's id for the message once Rome's mailbox took it. */
  async personWrites(text: string, threadId = `thread-${this.nextThread++}`): Promise<string> {
    const message = this.store.add({
      id: `in-${this.nextId++}`,
      conversation: threadId,
      from: "user",
      text,
    });
    this.list(threadId).push(item(message.id, threadId, ["received"]));
    const event: RomeMailEvent = {
      type: "message.received",
      provider: "agentmail",
      mailboxAddress: EMAIL_MAILBOX,
      id: `evt-${message.id}`,
      providerMessageId: message.id,
      threadId,
      from: [{ name: "Alice", email: EMAIL_PERSON }],
      to: [{ email: EMAIL_MAILBOX }],
      subject: "Plans",
      preview: text,
      receivedAt: new Date().toISOString(),
      hasAttachment: false,
      attachments: [],
      authentication: { authenticated: true, spam: false, blocked: false },
      labels: ["received"],
    };
    const raw = JSON.stringify(event);
    await this.adapter.ingestInbound(raw, createHmac("sha256", SECRET).update(raw).digest("hex"));
    return message.id;
  }

  private list(threadId: string): RomeMailListItem[] {
    let items = this.threads.get(threadId);
    if (!items) {
      items = [];
      this.threads.set(threadId, items);
    }
    return items;
  }

  private provider(): MailProvider {
    return {
      provision: async () => ({ address: EMAIL_MAILBOX, inboundSecret: SECRET }),
      send: async (mail) => {
        // A reply stays on the thread of the message it answers; anything
        // else starts a thread.
        const answered = mail.inReplyToMessageId
          ? this.store.get(mail.inReplyToMessageId)
          : undefined;
        if (mail.inReplyToMessageId && !answered) throw new Error("Message not found");
        const threadId = answered?.conversation ?? `thread-${this.nextThread++}`;
        const sent = this.store.add({
          id: `out-${this.nextId++}`,
          conversation: threadId,
          from: "rome",
          text: mail.text ?? "",
        });
        this.list(threadId).push(item(sent.id, threadId, ["sent"]));
        return { messageId: sent.id, threadId };
      },
      listMessages: async (params = {}) => {
        const all = [...this.threads.values()].flat();
        return { messages: params.ascending ? all : all.reverse() };
      },
      getMessage: async () => {
        throw new Error("The peer serves previews only");
      },
      getAttachment: async () => {
        throw new Error("The peer holds no attachments");
      },
    } as MailProvider;
  }
}

function item(providerMessageId: string, threadId: string, labels: string[]): RomeMailListItem {
  return { providerMessageId, threadId, receivedAt: new Date().toISOString(), labels };
}
