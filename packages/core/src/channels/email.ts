import { createHmac, timingSafeEqual } from "node:crypto";
import { v4 as uuid } from "uuid";
import type { Attachment, NormalizedMessage, OutgoingMessage } from "@rome-os/app-runtime";
import type { ProviderAdapter } from "./adapter.js";
import { createLogger } from "../logger.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { mapGuardianToChannel } from "./guardian-mapping.js";
import { InMemoryInboundDedup, type InboundDedup } from "./inbound-dedup.js";
import type {
  MailProvider,
  RomeMailEvent,
  RomeMailMessage,
  RomeMailListItem,
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
  personMappingRepo: PersonMappingRepository;
  config: EmailInboxCoordinates;
  /**
   * Resolve the account owner's (guardian's) email from Rome Cloud when none is
   * configured. Defaults to the `whoami` lookup; injectable for tests.
   */
  ownerEmailResolver?: () => Promise<string | undefined>;
  /**
   * Idempotency guard for at-least-once relay redelivery. Defaults to an
   * in-memory LRU; injectable so a persistent implementation can be swapped in
   * (or a deterministic one used in tests).
   */
  inboundDedup?: InboundDedup;
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

// Pull the display-name out of an RFC 5322 From string (`"Ray" <ray@x>` →
// `Ray`). Only used on the history fallback path, where a body hydration miss
// leaves us with the list item's raw `from` string instead of AgentMail's
// parsed name/email pair.
function parseDisplayName(value: string | undefined): string {
  if (!value) return "";
  const match = value.match(/^\s*"?([^"<]+?)"?\s*</u);
  return match ? match[1].trim() : "";
}

// Bounded-concurrency map, preserving input order. Hydrates history message
// bodies without firing one request per message at once against the mail API.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = cursor++; i < items.length; i = cursor++) {
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Default look-back when the caller's window is missing or invalid (matches the
// other history adapters, e.g. webchat).
const DEFAULT_HISTORY_WINDOW_HOURS = 24;
// History fetch bounds: cap total matched messages so an unbounded window can't
// pull the whole mailbox, page in chunks, and hydrate a few bodies at a time.
const HISTORY_MAX_MESSAGES = 200;
const HISTORY_PAGE_LIMIT = 100;
const HISTORY_HYDRATE_CONCURRENCY = 5;
// AgentMail's list has no server-side thread filter, so a thread-scoped fetch
// narrows client-side. This bounds how many messages we'll scan looking for
// matches before giving up, so a sparse thread in a busy inbox can't make us
// page the entire mailbox. Only relevant when threadId is set (otherwise the
// message cap is reached first).
const HISTORY_MAX_SCAN = 2000;
// Hard backstop on paging iterations. The scan cap counts *messages*, so it
// can't bound a misbehaving provider that returns empty pages with a non-null
// cursor (0 messages ⇒ scan count never advances). This caps the number of
// list calls regardless of what each page contains, guaranteeing termination.
const HISTORY_MAX_PAGES = 50;

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
 * Email as a first-class channel. Outbound reuses the standard
 * `ProviderAdapter.sendMessage` path; inbound is push-driven by Rome Cloud: the
 * `email_inbound` core-side action calls `ingestInbound()` with the raw relay
 * deposit, which this adapter verifies (HMAC), gates (authentication + From),
 * pulls the body for, normalizes, and feeds into the same `onMessage` pipeline
 * every other channel uses.
 */
export class EmailAdapter implements ProviderAdapter {
  readonly channelName = "email";

  private readonly provider: MailProvider;
  private readonly settingsRepo: SettingsRepository;
  private readonly personMappingRepo: PersonMappingRepository;
  private readonly ownerEmailResolver: () => Promise<string | undefined>;
  private readonly inboundDedup: InboundDedup;

  private address: string;
  private inboundSecret: string;
  private guardianEmail: string;

  private messageHandler: ((msg: NormalizedMessage) => Promise<void>) | null = null;

  // AgentMail wants a provider message id to keep a reply on-thread, but Rome's
  // thread key is the (stable) AgentMail thread id. Map the latest inbound
  // message id per thread so a reply can address the thread correctly. In-memory
  // is fine: a reply follows its inbound within the same process lifetime, and a
  // miss falls back to a fresh `to:` send.
  private readonly threadReplyTarget = new Map<string, string>();
  private readonly threadSubject = new Map<string, string>();

  // Per-inbound attachment manifest (provider message id → downloadable body
  // parts), set in ingestInbound and consumed by saveIncomingAttachments to pull
  // bytes via presigned URLs. Bounded by the number of unsaved inbound emails in
  // flight within one process lifetime.
  private readonly pendingAttachments = new Map<string, EmailBodyPart[]>();

  constructor(deps: EmailAdapterDeps) {
    this.provider = deps.provider;
    this.settingsRepo = deps.settingsRepo;
    this.personMappingRepo = deps.personMappingRepo;
    this.address = deps.config.address;
    this.inboundSecret = deps.config.inboundSecret;
    // guardianEmail is durable settings config, resolved from the settings row
    // (or self-healed from Rome Cloud) in start() — never carried in the grant.
    this.guardianEmail = "";
    this.ownerEmailResolver = deps.ownerEmailResolver ?? resolveOwnerEmailFromCloud;
    this.inboundDedup = deps.inboundDedup ?? new InMemoryInboundDedup();
  }

  /** The provisioned `<slug>@romeos.cc` address, once known. */
  getAddress(): string {
    return this.address;
  }

  /** Whether a history line is one this inbox sent. The history read names
   *  every line it counts as sent by this inbox's normalized address. */
  sentByThisInbox(message: NormalizedMessage): boolean {
    const selfAddress = normalizeAddress(this.address);
    return selfAddress !== "" && message.channelUserId === selfAddress;
  }

  async start(): Promise<void> {
    // Provisioning is route-driven: the connect ceremony calls
    // MailProvider.provision() and confers the `inbox` grant directly, so the
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
      await mapGuardianToChannel(this.personMappingRepo, "email", this.guardianEmail).catch(
        (err) => {
          log.warn("failed to preset guardian email mapping", {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );
    }

    log.info("email channel started", { address: this.address });
  }

  async stop(): Promise<void> {
    this.threadReplyTarget.clear();
    this.threadSubject.clear();
    this.pendingAttachments.clear();
    log.info("email channel stopped");
  }

  onMessage(handler: (msg: NormalizedMessage) => Promise<void>): void {
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

  async sendMessage(channelUserId: string, threadId: string, message: OutgoingMessage) {
    const email = message.kind === "email" ? message : undefined;
    const bodyText = (message.text ?? textFromParts(message.parts)).trim();

    // Build the multipart body: an app-supplied HTML wins (sanitized + inlined,
    // with a derived text/plain), otherwise render the markdown text to HTML.
    // Always send both `text` and `html`.
    let text: string | undefined;
    let html: string | undefined;
    if (email?.html?.trim()) {
      const multi = htmlToEmailMultipart(email.html, bodyText || undefined);
      html = multi.html;
      text = multi.text;
    } else if (bodyText) {
      const multi = markdownToEmailHtml(bodyText);
      html = multi.html;
      text = multi.text;
    }
    if (!text && !html) {
      log.debug("skipping empty outbound email", { threadId: threadId || null });
      return;
    }

    const cc = email?.cc?.length ? email.cc : undefined;
    const bcc = email?.bcc?.length ? email.bcc : undefined;

    // Reply on-thread when we have a provider message id — either passed
    // explicitly (survives restarts) or remembered from the inbound this process
    // handled. The provider keeps the subject/recipients of the original thread.
    const inReplyToMessageId = email?.inReplyToMessageId ?? this.threadReplyTarget.get(threadId);
    if (inReplyToMessageId) {
      const sent = await this.provider.send({ inReplyToMessageId, text, html, cc, bcc });
      log.info("sent email reply", { threadId: threadId || null });
      return sent;
    }

    // No thread: start a fresh email. Recipients come from `email.to`,
    // falling back to channelUserId for the legacy path.
    const recipients = this.resolveRecipients(email?.to ?? channelUserId);
    const hasRecipient = Array.isArray(recipients) ? recipients.length > 0 : !!recipients;
    if (!hasRecipient) {
      log.warn("cannot send email: no recipient resolved", { threadId: threadId || null });
      return;
    }
    const subject =
      email?.subject?.trim() || this.threadSubject.get(threadId) || "Message from Rome";
    const sent = await this.provider.send({ to: recipients, cc, bcc, subject, text, html });
    log.info("sent new email", {
      recipients: Array.isArray(recipients) ? recipients.length : 1,
    });
    return sent;
  }

  /**
   * Pull inbound attachment bytes on demand. The hook calls
   * this once per inbound that carries attachments. We resolve a short-lived
   * presigned URL per part via Rome Cloud, download directly, and persist under
   * the standard channel-attachment directory. Failures are logged and skipped
   * so one bad attachment never blocks the message.
   */
  async saveIncomingAttachments(message: NormalizedMessage): Promise<Attachment[]> {
    const parts = this.pendingAttachments.get(message.id);
    if (!parts || parts.length === 0) return message.attachments;

    const payloads: IncomingAttachmentPayload[] = [];
    for (const [index, part] of parts.entries()) {
      const attachment = message.attachments[index];
      if (!attachment || !part.blobId) continue;
      try {
        const download = await this.provider.getAttachment(message.id, part.blobId);
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
            messageId: message.id,
            bytes: err.bytes,
            fileName: part.name ?? null,
          });
          continue;
        }
        log.warn("failed to download email attachment, continuing", {
          messageId: message.id,
          fileName: part.name ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.pendingAttachments.delete(message.id);
    return saveIncomingAttachmentPayloads(message, payloads);
  }

  /**
   * Consume one inbound relay deposit (a signed `RomeMailEvent` JSON string).
   * Called by the `email_inbound` action after the connector transports the
   * deposit in. Verifies the per-inbox HMAC, applies the guardian gate, pulls
   * the body on demand, and dispatches a NormalizedMessage into the standard
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
    if (dedupKey && (await this.inboundDedup.checkAndRecord(dedupKey))) {
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
    const channelUserId = authenticated ? fromAddress : `unauthenticated:${fromAddress}`;
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
    this.threadReplyTarget.set(threadId, event.providerMessageId);
    this.threadSubject.set(threadId, event.subject ? `Re: ${event.subject}` : "Message from Rome");

    // Attachment manifest from the event (bytes pulled lazily by
    // saveIncomingAttachments). Keep the parts list aligned with the surfaced
    // attachments so the download step can map each back to its provider blob.
    const parts = downloadableParts(event.attachments ?? []);
    const attachments: Attachment[] = attachmentsFromParts(parts);
    const messageId = event.providerMessageId || uuid();
    if (parts.length > 0) this.pendingAttachments.set(messageId, parts);

    const normalized: NormalizedMessage = {
      id: messageId,
      channel: "email",
      channelUserId,
      displayName: fromName,
      threadId,
      threadName: event.subject,
      threadType: "private",
      timestamp: new Date(event.receivedAt ?? Date.now()),
      text,
      attachments,
      rawEvent: event,
    };

    await this.messageHandler(normalized);
    log.info("inbound email dispatched", {
      threadId,
      from: fromAddress,
      trusted: claimsGuardian && authenticated,
    });
    return { status: "dispatched" };
  }

  /**
   * Read-only history fetch (powers `fetch_channel_history` for email). Pages the
   * provider's `list` (newest-first, server-side filtered by `after` and with
   * spam/blocked/unauthenticated excluded by default), optionally narrows to one
   * thread, hydrates each message's full body via the on-demand pull path, and
   * returns NormalizedMessages oldest-first. This path is pure: unlike
   * `ingestInbound` it records no dedup, mutates no reply-target/subject/attachment
   * state, and dispatches nothing — it only reads and shapes.
   */
  async fetchHistory(threadId: string | null, windowHours: number): Promise<NormalizedMessage[]> {
    // `fetch_channel_history` accepts arbitrary numeric input from agents, so a
    // NaN/Infinity/negative window would throw on `toISOString()` or invert the
    // window into the future. Clamp to the default first, matching the other
    // history adapters.
    const effectiveWindowHours =
      Number.isFinite(windowHours) && windowHours > 0 ? windowHours : DEFAULT_HISTORY_WINDOW_HOURS;
    const afterIso = new Date(Date.now() - effectiveWindowHours * 60 * 60 * 1000).toISOString();

    // 1. Page newest-first, applying the optional thread filter *per page* so the
    //    cap counts matching messages, not raw mailbox volume. Without this, a
    //    thread-scoped fetch in a busy inbox could exhaust the cap on the newest
    //    200 messages overall — none of them in the requested thread — and return
    //    nothing even though the thread has messages in the window. Stop when we've
    //    collected enough matches, the cursor is exhausted, or we hit the scan
    //    ceiling (the latter only bites a sparse thread in a huge mailbox).
    const matched: RomeMailListItem[] = [];
    let pageToken: string | undefined;
    let scanned = 0;
    let pages = 0;
    let capHit = false;
    let scanCapHit = false;
    do {
      const page = await this.provider.listMessages({
        after: afterIso,
        limit: HISTORY_PAGE_LIMIT,
        ascending: false,
        pageToken,
      });
      pages += 1;
      scanned += page.messages.length;
      for (const m of page.messages) {
        if (threadId && m.threadId !== threadId) continue;
        matched.push(m);
        if (matched.length >= HISTORY_MAX_MESSAGES) {
          capHit = true;
          break;
        }
      }
      pageToken = page.nextPageToken;
      if (capHit) break;
      // Termination guards. An empty page means nothing more to collect, so stop
      // regardless of the cursor. The scan/page caps bound the worst case even
      // if the provider keeps handing back a non-null cursor — the loop can't run
      // away on a misbehaving list API.
      if (page.messages.length === 0) break;
      if (scanned >= HISTORY_MAX_SCAN || pages >= HISTORY_MAX_PAGES) {
        scanCapHit = true;
        break;
      }
    } while (pageToken);

    // Truncated only if we stopped early with more pages still available.
    if (capHit || (scanCapHit && Boolean(pageToken))) {
      log.warn("email history truncated", {
        reason: capHit ? "message-cap" : "scan-cap",
        cap: HISTORY_MAX_MESSAGES,
        scanCap: HISTORY_MAX_SCAN,
        scanned,
        matched: matched.length,
        windowHours: effectiveWindowHours,
        threadId: threadId ?? null,
      });
    }

    // 2. Hydrate full bodies (bounded concurrency); a pull miss falls back to the
    //    list preview rather than dropping the message.
    const normalized = await mapWithConcurrency(matched, HISTORY_HYDRATE_CONCURRENCY, (item) =>
      this.historyItemToMessage(item),
    );

    // 3. Oldest-first, matching the other channels' fetchHistory contract.
    return normalized.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  // Shape one listed message into a NormalizedMessage, hydrating its body. No
  // side effects — see fetchHistory.
  private async historyItemToMessage(item: RomeMailListItem): Promise<NormalizedMessage> {
    let text = (item.preview ?? "").trim();
    let full: RomeMailMessage | undefined;
    try {
      full = await this.provider.getMessage(item.providerMessageId);
      text = inboundBodyToMarkdown(full.body, item.preview);
    } catch (err) {
      log.warn("failed to hydrate email history body; falling back to preview", {
        messageId: item.providerMessageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const fromContact = firstAddress(full?.from);
    const fromAddress = normalizeAddress(fromContact?.email ?? item.from);
    const fromName = fromContact?.name?.trim() || parseDisplayName(item.from) || fromAddress;

    // A thread mixes inbound (counterparty) mail and outbound mail Rome itself
    // sent. AgentMail labels our own sends "sent"; we also treat a `from` that
    // matches our own inbox as outbound so attribution survives a label-vocabulary
    // change. Attributing outbound to Rome (rather than to the recipient) keeps
    // the transcript a readable two-sided conversation: received lines show the
    // counterparty, sent lines show Rome — mirroring the telegram-user adapter.
    const selfAddress = normalizeAddress(this.address);
    const isOutbound =
      item.labels.includes("sent") || (selfAddress !== "" && fromAddress === selfAddress);
    const channelUserId = isOutbound ? selfAddress : fromAddress;
    const displayName = isOutbound ? selfAddress : fromName;

    // Surface attachment metadata only (no lazy-download wiring on the read path).
    const parts = downloadableParts(full?.attachments ?? []);
    const attachments: Attachment[] = attachmentsFromParts(parts);

    return {
      id: item.providerMessageId,
      channel: "email",
      // The list already excludes unauthenticated mail, so no `unauthenticated:`
      // namespacing is needed here (unlike ingestInbound).
      channelUserId,
      displayName,
      threadId: item.threadId,
      threadName: full?.subject ?? item.subject,
      threadType: "private",
      timestamp: new Date(item.receivedAt || full?.receivedAt || Date.now()),
      text,
      attachments,
      rawEvent: full ?? item,
    };
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
