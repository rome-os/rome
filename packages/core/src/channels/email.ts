import { createHmac, timingSafeEqual } from "node:crypto";
import { v4 as uuid } from "uuid";
import type {
  Attachment,
  ChannelMessage,
  ChatId,
  MessageReceipt,
  OutgoingMessage,
} from "@rome-os/app-runtime";
import { createLogger } from "../logger.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { PeopleRepository } from "../db/repositories/people.js";
import { mapGuardianToChannel } from "./guardian-mapping.js";
import { InboundDedup } from "./inbound-dedup.js";
import {
  type EmailReplyTarget,
  type ResolvedEmailReplyTarget,
  resolveEmailReplyTarget,
} from "./email-reply-target.js";
import type {
  MailProvider,
  RomeMailEvent,
  SendMailResult,
  EmailAddress,
  EmailBodyPart,
} from "../lib/rome-cloud-mail.js";
import {
  inboundBodyToMarkdown,
  markdownToEmailHtml,
  htmlToEmailMultipart,
} from "../lib/email-markdown.js";
import {
  readAttachmentResponseBody,
  saveIncomingAttachmentPayloads,
  isAttachmentTooLargeError,
  type IncomingAttachmentPayload,
} from "./attachment-files.js";
import { proveIdentity } from "../lib/instance-identity.js";
import { getConfiguredInstanceOrigin } from "../lib/rome-cloud-origin.js";

const log = createLogger("channel-email");

export const EMAIL_SETTINGS_KEY = "email";

/**
 * Stored under the `email` settings key — PURE config.
 * The provisioned inbox address + inbound HMAC secret are credential material and
 * live only on the `inbox` grant, never here. `enabled` and `guardianEmail` are
 * durable operator choices that deliberately survive a disconnect/revoke:
 * `guardianEmail` seeds the `guardian email → guardian` channel mapping and is
 * the trust anchor for the inbound gate.
 */
export interface EmailSettings {
  enabled: boolean;
  guardianEmail?: string;
}

/**
 * The provisioned coordinates the adapter transports on — the `inbox` grant's
 * secret material. Threaded in from the grant at capability-build
 * time, never read from the settings table.
 */
export interface EmailInboxCoordinates {
  address: string;
  inboundSecret: string;
}

export interface EmailAdapterDeps {
  provider: MailProvider;
  settingsRepo: SettingsRepository;
  peopleRepo: PeopleRepository;
  config: EmailInboxCoordinates;
  /**
   * Resolve the account owner's (guardian's) email from Rome Cloud when none is
   * configured. Defaults to the `whoami` lookup; injectable for tests.
   */
  ownerEmailResolver?: () => Promise<string | undefined>;
}

/** Default owner-email resolver: the whoami identity carries the
 *  signed-up account email, which is the guardian's. */
async function resolveOwnerEmailFromCloud(): Promise<string | undefined> {
  const result = await proveIdentity();
  return result.status === "ok" ? result.identity.email : undefined;
}

// Parse an addr-spec out of a From value that may carry a display name, e.g.
// `"Ray <ray@example.com>"` → `ray@example.com`. AgentMail already splits
// name/email for us in the structured `from[]`, but we normalize defensively.
function normalizeAddress(value: string | undefined): string {
  if (!value) return "";
  const match = value.match(/<([^>]+)>/u);
  const raw = match ? match[1] : value;
  return raw.trim().toLowerCase();
}

function firstAddress(list: EmailAddress[] | undefined): EmailAddress | undefined {
  return list && list.length > 0 ? list[0] : undefined;
}

const REPLY_TARGET_CACHE_SIZE = 2000;

function attachmentTypeFromMime(mime: string | undefined): Attachment["type"] {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "document";
}

// Real attachments worth surfacing: drop inline parts that the HTML body
// references by Content-ID (logos, embedded images) — those belong to the
// rendered body, not the attachment list.
function downloadableParts(parts: EmailBodyPart[]): EmailBodyPart[] {
  return parts.filter((p) => p.blobId && !(p.cid && (p.disposition ?? "") === "inline"));
}

// Body bytes are pulled lazily in `saveIncomingAttachments`; here we only
// carry metadata so the message handler can see what's attached.
function attachmentsFromParts(parts: EmailBodyPart[]): Attachment[] {
  return parts.map((p) => ({
    type: attachmentTypeFromMime(p.type),
    mimeType: p.type,
    fileName: p.name,
  }));
}

function textFromParts(parts: OutgoingMessage["parts"]): string {
  if (!parts) return "";
  return parts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.content)
    .join("\n\n")
    .trim();
}

/**
 * Email as a first-class channel. Inbound is push-driven by Rome Cloud: the
 * `email_inbound` core-side action calls `ingestInbound()` with the raw relay
 * deposit, which this adapter verifies (HMAC), gates (authentication + From),
 * pulls the body for, and hands to `onInbound` as the channel's own record, a
 * `ChannelMessage` whose `raw` is the `RomeMailEvent`. The Connection
 * integration delivers it as it is.
 */
export class EmailAdapter {
  private readonly provider: MailProvider;
  private readonly settingsRepo: SettingsRepository;
  private readonly peopleRepo: PeopleRepository;
  private readonly ownerEmailResolver: () => Promise<string | undefined>;
  private readonly inboundDedup = new InboundDedup();

  private address: string;
  private inboundSecret: string;
  private guardianEmail: string;

  private messageHandler: ((msg: ChannelMessage) => Promise<void>) | null = null;

  // The message each thread's replies target: the newest inbound, or the newest
  // message Rome sent, for a thread with no inbound. The mailbox scan applies
  // the same rule. This bounded cache saves that scan per reply but is not
  // durable state; a miss falls back to the scan.
  private readonly threadReplyTarget = new Map<string, EmailReplyTarget>();

  // Per-inbound attachment manifest (provider message id → downloadable body
  // parts), set in ingestInbound and consumed by saveIncomingAttachments to pull
  // bytes via presigned URLs. Bounded by the number of unsaved inbound emails in
  // flight within one process lifetime.
  private readonly pendingAttachments = new Map<string, EmailBodyPart[]>();

  constructor(deps: EmailAdapterDeps) {
    this.provider = deps.provider;
    this.settingsRepo = deps.settingsRepo;
    this.peopleRepo = deps.peopleRepo;
    this.address = deps.config.address;
    this.inboundSecret = deps.config.inboundSecret;
    // guardianEmail is durable settings config, resolved from the settings row
    // (or self-healed from Rome Cloud) in start() — never carried in the grant.
    this.guardianEmail = "";
    this.ownerEmailResolver = deps.ownerEmailResolver ?? resolveOwnerEmailFromCloud;
  }

  /** The provisioned `<slug>@romeos.cc` address, once known. */
  getAddress(): string {
    return this.address;
  }

  async start(): Promise<void> {
    // Provisioning is route-driven: the connect ceremony calls
    // MailProvider.provision() and grants the `inbox` grant directly, so the
    // registry only ever builds this adapter from complete grant material —
    // there is no secretless start here to self-provision.

    // guardianEmail is durable settings config (it deliberately survives
    // revoke). Read the configured guardian address from
    // the settings row; when absent, self-heal from Rome Cloud below.
    const configured = await this.settingsRepo.get<EmailSettings>(EMAIL_SETTINGS_KEY);
    if (configured?.guardianEmail) {
      this.guardianEmail = normalizeAddress(configured.guardianEmail);
    }

    // No guardian address configured → fall back to the account owner's email
    // from Rome Cloud. The signed-up account email is the guardian's,
    // so this drops the manual-entry step; a dashboard-configured address always
    // wins (we only reach here when none was set). Persist it so the mapping
    // below and later reboots reuse it. Best-effort: a miss just leaves the gate
    // closed (all inbound → sentinel), never blocks startup.
    if (!this.guardianEmail) {
      try {
        const ownerEmail = await this.ownerEmailResolver();
        if (ownerEmail) {
          this.guardianEmail = normalizeAddress(ownerEmail);
          const current = (await this.settingsRepo.get<EmailSettings>(EMAIL_SETTINGS_KEY)) ?? {
            enabled: true,
          };
          await this.settingsRepo.set(EMAIL_SETTINGS_KEY, {
            ...current,
            guardianEmail: this.guardianEmail,
          });
          log.info("guardian email resolved from Rome Cloud", {
            guardianEmail: this.guardianEmail,
          });
        }
      } catch (err) {
        log.warn("failed to resolve guardian email from Rome Cloud", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Preset the guardian mapping so authenticated mail from the guardian's
    // known address lands on the trusted path. The inbound gate still enforces
    // authentication before honoring this mapping (see ingestInbound).
    if (this.guardianEmail) {
      await mapGuardianToChannel(this.peopleRepo, "email", this.guardianEmail).catch((err) => {
        log.warn("failed to preset guardian email mapping", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    log.info("email channel started", { address: this.address });
  }

  async stop(): Promise<void> {
    this.threadReplyTarget.clear();
    this.pendingAttachments.clear();
    log.info("email channel stopped");
  }

  onInbound(handler: (msg: ChannelMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }

  // Resolve recipient(s), expanding the `"guardian"` alias to the configured
  // guardian address and normalizing addr-specs. Drops the `unauthenticated:`
  // namespace a spoofed inbound carries so it can never be addressed back.
  private resolveRecipient(addr: string): string {
    const raw = addr.replace(/^unauthenticated:/u, "").trim();
    if (raw.toLowerCase() === "guardian") return this.guardianEmail || raw;
    return normalizeAddress(raw) || raw;
  }

  private resolveRecipients(to: string | string[]): string | string[] {
    if (Array.isArray(to)) {
      return to.map((a) => this.resolveRecipient(a)).filter((a) => a.includes("@"));
    }
    const resolved = this.resolveRecipient(to);
    return resolved.includes("@") ? resolved : "";
  }

  /**
   * Send into a conversation and return the provider's receipt: its message ID
   * and thread ID. Unresolved threads, unresolved recipients, and attachments
   * throw before anything is sent. A provider answer without both IDs throws as
   * unconfirmed, since the mail may have gone out.
   *
   * An empty body is the one exception that neither sends nor throws, unless the
   * caller asked for an email explicitly (`kind: "email"`). Parts-only messages
   * such as approval cards have no email rendering, so the adapter skips them and
   * receipts the conversation it was asked for, without a `messageId`.
   *
   * A thread reply targets the newest received message in the thread, falling
   * back to the newest message Rome sent for a thread nobody else wrote in.
   */
  async send(chatId: ChatId, message: OutgoingMessage): Promise<MessageReceipt> {
    const outcome = await this.sendMail(chatId, message);
    if (!outcome) return { chatId };
    const { sent, startedThread } = outcome;
    // An explicit reply on an uncached thread says nothing about whether the
    // thread has inbound mail, so only a new or cached thread records the send.
    if (startedThread || this.threadReplyTarget.has(sent.threadId)) {
      this.rememberReplyTarget(sent.threadId, { messageId: sent.messageId, outbound: true });
    }
    log.info("email accepted by provider", { threadId: sent.threadId, messageId: sent.messageId });
    return { chatId: sent.threadId as ChatId, messageId: sent.messageId };
  }

  // A sent message never replaces a received one, so once a thread has inbound
  // mail, replies keep addressing the other party.
  private rememberReplyTarget(threadId: string, target: EmailReplyTarget): void {
    if (!threadId || !target.messageId) return;
    const cached = this.threadReplyTarget.get(threadId);
    const next = target.outbound && cached && !cached.outbound ? cached : target;
    this.threadReplyTarget.delete(threadId);
    this.threadReplyTarget.set(threadId, next);
    if (this.threadReplyTarget.size > REPLY_TARGET_CACHE_SIZE) {
      const oldest = this.threadReplyTarget.keys().next().value;
      if (oldest !== undefined) this.threadReplyTarget.delete(oldest);
    }
  }

  private async threadReplyTargetFor(threadId: string): Promise<EmailReplyTarget> {
    const cached = this.threadReplyTarget.get(threadId);
    if (cached) return cached;
    let resolved: ResolvedEmailReplyTarget;
    try {
      resolved = await resolveEmailReplyTarget(this.provider, threadId, {
        isOutbound: (item) => this.isOwnMessage(item.labels, normalizeAddress(item.from)),
      });
    } catch (err) {
      // A target cached while the lookup ran is as good as a cache hit.
      const live = this.threadReplyTarget.get(threadId);
      if (live) return live;
      throw err;
    }
    const target = { messageId: resolved.messageId, outbound: resolved.outbound };
    // A target cached while the lookup ran is newer than anything it found,
    // unless it is Rome's own message and the lookup found an inbound one.
    const live = this.threadReplyTarget.get(threadId);
    if (live && (!live.outbound || target.outbound)) return live;
    // A fallback from a lookup cut short serves this send only, so the next
    // reply looks for the inbound again.
    if (resolved.complete) this.rememberReplyTarget(threadId, target);
    return target;
  }

  // AgentMail labels this inbox's own sends "sent". A `from` equal to the inbox
  // address also counts, so the rule survives a change in label vocabulary.
  private isOwnMessage(labels: string[], fromAddress: string): boolean {
    const selfAddress = normalizeAddress(this.address);
    return labels.includes("sent") || (selfAddress !== "" && fromAddress === selfAddress);
  }

  /** Returns undefined only when an empty body was skipped without sending. */
  private async sendMail(
    threadId: string,
    message: OutgoingMessage,
  ): Promise<{ sent: SendMailResult; startedThread: boolean } | undefined> {
    // The mail transport has no attachment field. Reject before sending a body
    // that would falsely appear to deliver the requested files.
    if (message.attachments?.length) {
      throw new Error(
        "Email attachments are not supported by the mail transport. No email was sent.",
      );
    }
    const email = message.kind === "email" ? message : undefined;
    if (email?.inReplyToMessageId !== undefined && !email.inReplyToMessageId.trim()) {
      throw new Error("Email replyToMessageId must not be blank. No email was sent.");
    }
    const bodyText = (message.text ?? textFromParts(message.parts)).trim();

    // Build the multipart body: an app-supplied HTML wins (sanitized + inlined,
    // with a derived text/plain), otherwise render the markdown text to HTML.
    // Always send both `text` and `html`.
    const instanceOrigin = getConfiguredInstanceOrigin();
    let text: string | undefined;
    let html: string | undefined;
    if (email?.html?.trim()) {
      const multi = htmlToEmailMultipart(email.html, bodyText || undefined, instanceOrigin);
      html = multi.html;
      text = multi.text;
    } else if (bodyText) {
      const multi = markdownToEmailHtml(bodyText, instanceOrigin);
      html = multi.html;
      text = multi.text;
    }
    if (!text && !html) {
      if (email) throw new Error("Email requires non-empty text or HTML. No email was sent.");
      log.debug("skipping empty outbound email", { threadId: threadId || null });
      return undefined;
    }

    const cc = email?.cc?.length ? email.cc : undefined;
    const bcc = email?.bcc?.length ? email.bcc : undefined;

    // An explicit message ID wins. A thread miss must not become a fresh send,
    // even when the caller also supplied `to`.
    if (email?.inReplyToMessageId) {
      const inReplyToMessageId = email.inReplyToMessageId;
      const sent = await this.provider.send({ inReplyToMessageId, text, html, cc, bcc });
      return { sent, startedThread: false };
    }
    // A chat-style conversation id that names an address or the guardian alias
    // starts a new email, so a missing guardian address gets its own error.
    const addressTarget =
      !email &&
      (!!this.resolveRecipients(threadId) || threadId.trim().toLowerCase() === "guardian");
    if (threadId && (this.threadReplyTarget.has(threadId) || !addressTarget)) {
      const target = await this.threadReplyTargetFor(threadId);
      if (target.outbound) {
        // Where the provider delivers a reply to Rome's own message is
        // unverified, so leave a trace for anyone checking that path.
        log.info("email reply targets a message Rome sent", {
          threadId,
          inReplyToMessageId: target.messageId,
        });
      }
      const inReplyToMessageId = target.messageId;
      const sent = await this.provider.send({ inReplyToMessageId, text, html, cc, bcc });
      return { sent, startedThread: false };
    }

    // No thread: start a fresh email. Recipients come from `email.to`,
    // falling back to the conversation id, which then names the address.
    const to = email?.to ?? threadId;
    const recipients = this.resolveRecipients(to);
    const hasRecipient = Array.isArray(recipients) ? recipients.length > 0 : !!recipients;
    if (!hasRecipient) throw new Error(this.noRecipientMessage(to));
    const subject = email?.subject?.trim() || "Message from Rome";
    const sent = await this.provider.send({ to: recipients, cc, bcc, subject, text, html });
    return { sent, startedThread: true };
  }

  private noRecipientMessage(to: string | string[]): string {
    const values = (Array.isArray(to) ? to : [to]).map((value) => value.trim());
    if (values.some((value) => value.toLowerCase() === "guardian") && !this.guardianEmail) {
      return (
        'Cannot send email to "guardian": Rome has no guardian email address yet. ' +
        "No email was sent. Set `to` to an email address."
      );
    }
    const shown = values.map((value) => JSON.stringify(value)).join(", ") || '""';
    const verdict = values.length > 1 ? `none of ${shown} is` : `${shown} is not`;
    return (
      `Cannot send email: ${verdict} an email address. No email was sent. ` +
      'Set `to` to an email address or "guardian", or reply on a thread with `threadId`.'
    );
  }

  /**
   * Pull inbound attachment bytes on demand. The hook calls
   * this once per inbound that carries attachments. We resolve a short-lived
   * presigned URL per part via Rome Cloud, download directly, and persist under
   * the standard channel-attachment directory. Failures are logged and skipped
   * so one bad attachment never blocks the message. The parts come from what
   * `ingestInbound` recorded under `message.messageId`, not from `raw`, so a
   * message this adapter did not ingest returns its attachments unchanged.
   */
  async saveIncomingAttachments(message: ChannelMessage): Promise<Attachment[]> {
    const parts = this.pendingAttachments.get(message.messageId);
    if (!parts || parts.length === 0) return message.attachments;

    const payloads: IncomingAttachmentPayload[] = [];
    for (const [index, part] of parts.entries()) {
      const attachment = message.attachments[index];
      if (!attachment || !part.blobId) continue;
      try {
        const download = await this.provider.getAttachment(message.messageId, part.blobId);
        const response = await fetch(download.downloadUrl, {
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok) {
          throw new Error(`download failed: ${response.status}`);
        }
        payloads.push({
          attachment,
          data: await readAttachmentResponseBody(response),
          mimeType: download.contentType ?? part.type ?? attachment.mimeType,
          fileName: download.filename ?? part.name ?? attachment.fileName,
        });
      } catch (err) {
        if (isAttachmentTooLargeError(err)) {
          log.warn("email attachment too large, skipping save", {
            messageId: message.messageId,
            bytes: err.bytes,
            fileName: part.name ?? null,
          });
          continue;
        }
        log.warn("failed to download email attachment, continuing", {
          messageId: message.messageId,
          fileName: part.name ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.pendingAttachments.delete(message.messageId);
    return saveIncomingAttachmentPayloads({ ...message, channel: "email" }, payloads);
  }

  /**
   * Consume one inbound relay deposit (a signed `RomeMailEvent` JSON string).
   * Called by the `email_inbound` action after the connector transports the
   * deposit in. Verifies the per-inbox HMAC, applies the guardian gate, pulls
   * the body on demand, and dispatches a ChannelMessage into the standard
   * channel pipeline. Returns the disposition for logging/tests.
   */
  async ingestInbound(
    rawBody: string,
    signature: string,
  ): Promise<{ status: "dispatched" | "rejected" | "skipped"; reason?: string }> {
    if (!this.inboundSecret) {
      log.warn("inbound email dropped: inbox not provisioned");
      return { status: "skipped", reason: "not_provisioned" };
    }

    if (!this.verifySignature(rawBody, signature)) {
      log.warn("inbound email dropped: HMAC verification failed");
      return { status: "rejected", reason: "bad_signature" };
    }

    let event: RomeMailEvent;
    try {
      event = JSON.parse(rawBody) as RomeMailEvent;
    } catch (err) {
      log.warn("inbound email dropped: invalid JSON", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: "rejected", reason: "invalid_json" };
    }

    if (!this.messageHandler) {
      log.warn("inbound email dropped: no message handler registered");
      return { status: "skipped", reason: "no_handler" };
    }

    // Idempotency: the relay drainer is at-least-once, so an ack lost across a
    // reconnect redelivers the same deposit. Skip a providerMessageId we've
    // already handled rather than re-dispatching (and possibly re-replying). Key
    // on the stable provider/event id — never the random `uuid()` body fallback
    // used below, which would defeat dedup. With neither id present we can't
    // dedup, so fall through and process.
    const dedupKey = event.providerMessageId || event.id;
    if (dedupKey && this.inboundDedup.checkAndRecord(dedupKey)) {
      log.info("inbound email skipped: duplicate redelivery", { dedupKey });
      return { status: "skipped", reason: "duplicate" };
    }

    const fromContact = firstAddress(event.from);
    const fromAddress = normalizeAddress(fromContact?.email);
    const fromName = fromContact?.name?.trim() || fromAddress;

    // Auth gate: only authenticated mail (SPF/DKIM/DMARC passed — AgentMail
    // strips the `unauthenticated` label) is honored at face value. Because the
    // From header is freely forgeable, mail that fails auth is namespaced under
    // `unauthenticated:` for EVERY sender — not just the guardian — so a spoofed
    // From can never resolve to a mapped person (guardian, inner-circle, or
    // acquaintance) and reach the trusted path. The unmapped namespaced id falls
    // through to the untrusted/sentinel path; `resolveRecipient` strips the
    // prefix so a reply still addresses the real mailbox.
    const authenticated =
      event.authentication?.authenticated === true && !event.authentication.blocked;
    const claimsGuardian = !!this.guardianEmail && fromAddress === this.guardianEmail;
    const senderId = authenticated ? fromAddress : `unauthenticated:${fromAddress}`;
    if (!authenticated) {
      log.warn("inbound email failed authentication; routing untrusted", {
        from: fromAddress,
        claimsGuardian,
      });
    }

    // Pull the full message body on demand (the event carries only metadata +
    // preview). The body is converted HTML→Markdown with email-domain cleaning.
    // A pull failure falls back to the preview so we still surface the message
    // rather than dropping it.
    let text = (event.preview ?? "").trim();
    try {
      const full = await this.provider.getMessage(event.providerMessageId);
      text = inboundBodyToMarkdown(full.body, event.preview);
    } catch (err) {
      log.warn("failed to pull email body; falling back to preview", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const threadId = event.threadId;
    this.rememberReplyTarget(threadId, { messageId: event.providerMessageId, outbound: false });

    // Attachment manifest from the event (bytes pulled lazily by
    // saveIncomingAttachments). Keep the parts list aligned with the surfaced
    // attachments so the download step can map each back to its provider blob.
    const parts = downloadableParts(event.attachments ?? []);
    const attachments: Attachment[] = attachmentsFromParts(parts);
    const messageId = event.providerMessageId || uuid();
    if (parts.length > 0) this.pendingAttachments.set(messageId, parts);

    const message: ChannelMessage = {
      channel: "email",
      direction: "inbound",
      messageId,
      chatId: threadId as ChatId,
      senderId,
      senderDisplayName: fromName,
      text,
      attachments,
      timestamp: new Date(event.receivedAt ?? Date.now()),
      thread: { kind: "dm", ...(event.subject ? { name: event.subject } : {}) },
      raw: event,
    };

    await this.messageHandler(message);
    log.info("inbound email dispatched", {
      threadId,
      from: fromAddress,
      trusted: claimsGuardian && authenticated,
    });
    return { status: "dispatched" };
  }

  private verifySignature(rawBody: string, signature: string): boolean {
    if (!signature) return false;
    const expected = createHmac("sha256", this.inboundSecret).update(rawBody).digest("hex");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
