import { getInstanceToken } from "./instance-identity.js";
import { getRomeCloudOrigin } from "./rome-cloud-origin.js";
import { createLogger } from "../logger.js";

const log = createLogger("rome-cloud-mail");

/** How long one Rome Cloud mail API request may take before it aborts. */
export const MAIL_REQUEST_TIMEOUT_MS = 15_000;

// The instance-side client for Rome Cloud's provider-agnostic "Rome Mail" API
// (Phase 1 as-built). The AgentMail key lives only in Rome Cloud (the
// `romeCloud` codename in the repo); the instance authenticates every call with
// its instance token and only ever speaks the RomeMail contract, so
// swapping AgentMail for another provider is a cloud-only change.
//
// Types here mirror the leaf shapes the cloud returns
// (owned by the Rome Cloud mail implementation). We vendor a subset
// rather than depend on the Next.js package — only the fields the instance
// consumes are modeled; unknown fields are tolerated.

export interface EmailAddress {
  name?: string;
  email: string;
}

export interface EmailBodyPart {
  partId?: string;
  blobId?: string;
  size: number;
  name?: string;
  type: string;
  disposition?: string;
  cid?: string;
}

export type AuthVerdict = "pass" | "fail" | "none";

export interface MailAuthentication {
  authenticated: boolean;
  dmarc?: AuthVerdict;
  spam: boolean;
  blocked: boolean;
}

/** The thin event deposited into the relay (no body — body is pulled on demand). */
export interface RomeMailEvent {
  type: "message.received";
  provider: string;
  mailboxAddress: string;
  id: string;
  providerMessageId: string;
  threadId: string;
  from?: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  subject?: string;
  preview?: string;
  sentAt?: string;
  receivedAt: string;
  hasAttachment: boolean;
  attachments: EmailBodyPart[];
  authentication: MailAuthentication;
  labels: string[];
}

export interface RomeMailBody {
  markdown?: string;
  text?: string;
  html?: string;
  strippedText?: string;
  strippedHtml?: string;
}

/** The full message returned by the pull endpoint. */
export interface RomeMailMessage {
  id: string;
  threadId: string;
  messageId?: string[];
  inReplyTo?: string[];
  references?: string[];
  from?: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  subject?: string;
  preview?: string;
  receivedAt: string;
  body: RomeMailBody;
  attachments: EmailBodyPart[];
  hasAttachment: boolean;
  provider: string;
  providerMessageId: string;
  mailboxAddress: string;
  direction: "inbound" | "outbound";
  authentication: MailAuthentication;
  labels: string[];
}

export interface MailAttachmentDownload {
  downloadUrl: string;
  expiresAt: string;
  filename?: string;
  contentType?: string;
  size: number;
}

/**
 * One row of the message-list endpoint (the `list` side of the
 * thin-event model). Carries only metadata + preview, never the body: a history
 * reader pages this list and hydrates the bodies it cares about via
 * {@link MailProvider.getMessage}. `from` is the provider's RFC 5322 string
 * (e.g. `"Ray <ray@example.com>"`), not a parsed pair.
 */
export interface RomeMailListItem {
  providerMessageId: string;
  threadId: string;
  from?: string;
  subject?: string;
  preview?: string;
  /** ISO-8601 receipt timestamp. */
  receivedAt: string;
  labels: string[];
}

export interface ListMessagesParams {
  /** Lower time bound (ISO-8601); maps to the provider's `after`. */
  after?: string;
  /** Upper time bound (ISO-8601); maps to the provider's `before`. */
  before?: string;
  /** Page size. */
  limit?: number;
  /** Sort ascending by timestamp (default provider order is descending). */
  ascending?: boolean;
  /** Cursor from a previous page's `nextPageToken`. */
  pageToken?: string;
}

export interface ListMessagesResult {
  messages: RomeMailListItem[];
  nextPageToken?: string;
}

export interface ProvisionResult {
  address: string;
  inboundSecret: string;
}

export interface SendMailInput {
  to?: string | string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  /** Provider message id to reply to (keeps the AgentMail thread). */
  inReplyToMessageId?: string;
}

export interface SendMailResult {
  messageId: string;
  threadId: string;
}

/**
 * The instance-side mail seam. v1 has exactly one implementation
 * (`RomeCloudMailProvider`), but the EmailAdapter depends on this interface so a
 * future local/direct provider can drop in without adapter changes.
 */
export interface MailProvider {
  provision(): Promise<ProvisionResult>;
  send(input: SendMailInput): Promise<SendMailResult>;
  getMessage(messageId: string): Promise<RomeMailMessage>;
  getAttachment(messageId: string, attachmentId: string): Promise<MailAttachmentDownload>;
  /** List inbox messages (metadata + preview only). The provider excludes
   *  spam/blocked/unauthenticated mail by default. */
  listMessages(params?: ListMessagesParams): Promise<ListMessagesResult>;
}

export class MailProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "MailProviderError";
  }
}

export interface RomeCloudMailProviderOptions {
  /** Override fetch (tests). Defaults to global `fetch`. */
  fetch?: typeof fetch;
}

export class RomeCloudMailProvider implements MailProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(options: RomeCloudMailProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private resolve(): { token: string; origin: string } {
    const token = getInstanceToken();
    if (!token) {
      throw new MailProviderError(
        "instance is not enrolled (no instance token)",
        undefined,
        "no_token",
      );
    }
    const origin = getRomeCloudOrigin();
    if (!origin) {
      throw new MailProviderError("Rome Cloud origin is not configured", undefined, "unconfigured");
    }
    return { token, origin };
  }

  private async request<T>(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown } = { method: "GET" },
  ): Promise<T> {
    const { token, origin } = this.resolve();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Cache-Control": "no-store",
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path, origin), {
        method: init.method,
        headers,
        cache: "no-store",
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(MAIL_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new MailProviderError(
        `could not reach Rome Cloud mail API: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        "unreachable",
      );
    }

    if (!response.ok) {
      // Rome Cloud forwards the underlying provider error (AgentMail's
      // statusCode + body) so a real failure is diagnosable from the Rome side
      // instead of an opaque `mail_provider_error`.
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        providerStatus?: number;
        detail?: unknown;
      } | null;
      const parts: string[] = [];
      if (body?.error) parts.push(body.error);
      if (typeof body?.providerStatus === "number")
        parts.push(`provider status ${body.providerStatus}`);
      if (body?.detail !== undefined && body.detail !== null) {
        parts.push(typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail));
      }
      throw new MailProviderError(
        `Rome Cloud mail API ${path} failed (${response.status})${parts.length ? `: ${parts.join(" — ")}` : ""}`,
        response.status,
        body?.error,
      );
    }

    return (await response.json()) as T;
  }

  async provision(): Promise<ProvisionResult> {
    const data = await this.request<{ address?: unknown; inboundSecret?: unknown }>(
      "/api/instance/mail/provision",
      { method: "POST", body: {} },
    );
    const address = typeof data.address === "string" ? data.address : "";
    const inboundSecret = typeof data.inboundSecret === "string" ? data.inboundSecret : "";
    if (!address || !inboundSecret) {
      throw new MailProviderError(
        "provision returned an invalid payload",
        undefined,
        "invalid_payload",
      );
    }
    log.info("provisioned mailbox", { address });
    return { address, inboundSecret };
  }

  async send(input: SendMailInput): Promise<SendMailResult> {
    const data = await this.request<{ messageId?: unknown; threadId?: unknown }>(
      "/api/instance/mail/send",
      { method: "POST", body: input },
    );
    const messageId = typeof data.messageId === "string" ? data.messageId.trim() : "";
    const threadId = typeof data.threadId === "string" ? data.threadId.trim() : "";
    // Rome Cloud answered 200, so the mail may have gone out. Say so, rather
    // than invite a retry that could send it twice.
    if (!messageId || !threadId) {
      throw new MailProviderError(
        "Email delivery is unconfirmed: Rome Cloud did not return valid message and thread IDs. " +
          "Check email history before retrying to avoid sending a duplicate.",
        undefined,
        "invalid_payload",
      );
    }
    return { messageId, threadId };
  }

  async getMessage(messageId: string): Promise<RomeMailMessage> {
    const query = new URLSearchParams({ messageId });
    return this.request<RomeMailMessage>(`/api/instance/mail/message?${query.toString()}`);
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<MailAttachmentDownload> {
    const query = new URLSearchParams({ messageId, attachmentId });
    return this.request<MailAttachmentDownload>(
      `/api/instance/mail/attachment?${query.toString()}`,
    );
  }

  async listMessages(params: ListMessagesParams = {}): Promise<ListMessagesResult> {
    const query = new URLSearchParams();
    if (params.after) query.set("after", params.after);
    if (params.before) query.set("before", params.before);
    if (typeof params.limit === "number") query.set("limit", String(params.limit));
    if (typeof params.ascending === "boolean") query.set("ascending", String(params.ascending));
    if (params.pageToken) query.set("pageToken", params.pageToken);
    const qs = query.toString();
    return this.request<ListMessagesResult>(`/api/instance/mail/list${qs ? `?${qs}` : ""}`);
  }
}
