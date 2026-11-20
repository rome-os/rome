import { z } from "zod";
import { CredentialRejected } from "../errors.js";
import type { Actor, Credential, SecretRecord } from "../types.js";

// Graph ids are URL-safe base64; well-known folder names (inbox, sentitems) match too.
const id = "[A-Za-z0-9_=-]+";
const queryKeys = ["$select", "$filter", "$search", "$top", "$skip", "$orderby", "$count"] as const;
const queryValue = z.union([z.string(), z.number(), z.boolean()]);
export const outlookReadSchema = z
  .object({
    // Profile, messages and folders only: no attachments, MIME ($value) or other Graph APIs.
    path: z
      .string()
      .regex(
        new RegExp(
          `^/v1\\.0/me(?:/messages(?:/${id})?|/mailFolders(?:/${id}(?:/messages(?:/${id})?)?)?)?$`,
        ),
      ),
    query: z.partialRecord(z.enum(queryKeys), queryValue).optional(),
    method: z.literal("GET").optional(),
    host: z.literal("graph.microsoft.com").optional(),
    body: z.never().optional(),
    headers: z.never().optional(),
  })
  .strict();

const email = z.email().regex(/^[^\s<>(),;:\\"\r\n]+@[^\s<>(),;:\\"\r\n]+$/);
export const outlookSendSchema = z
  .object({
    connectionId: z.string().min(1),
    from: email,
    to: z.array(email).min(1).max(50),
    subject: z
      .string()
      .max(998)
      .refine((value) => !/[\r\n\x00-\x1f\x7f]/.test(value)),
    body: z.string().max(1_000_000),
  })
  .strict();
export type OutlookSendInput = z.infer<typeof outlookSendSchema>;

export interface OutlookResponse {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

/** The mailbox Graph sends from. Personal accounts may leave `mail` empty. */
export function outlookSenderAddress(profile: unknown): string | null {
  const me = profile as { mail?: unknown; userPrincipalName?: unknown } | null;
  const address = typeof me?.mail === "string" && me.mail ? me.mail : me?.userPrincipalName;
  return typeof address === "string" && address ? address.toLowerCase() : null;
}

/** Only the plain-text fields shown on the approval card: no Cc, Bcc, attachments or headers. */
export function outlookSendMailBody(input: OutlookSendInput) {
  return {
    message: {
      subject: input.subject,
      body: { contentType: "Text", content: input.body },
      toRecipients: input.to.map((address) => ({ emailAddress: { address } })),
    },
    saveToSentItems: true,
  };
}

/** A Core-only Actor: no appAccess, no token file, and no general-purpose authenticated proxy. */
export function createOutlookActor(credential: Credential): Actor {
  const lifetime = new AbortController();
  const material = async (): Promise<SecretRecord> =>
    typeof credential.material === "function" ? credential.material() : credential.material;
  const request = async (
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    body?: unknown,
  ): Promise<OutlookResponse> => {
    const url = new URL(`https://graph.microsoft.com${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    lifetime.signal.throwIfAborted();
    const token = (await material()).accessToken;
    lifetime.signal.throwIfAborted();
    if (!token) throw new Error("Microsoft access token is unavailable.");
    const response = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        // Graph requires this for $search and for $count on messages.
        ...(query?.$search !== undefined || query?.$count !== undefined
          ? { ConsistencyLevel: "eventual" }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      // A send already dispatched with approval finishes across routine renewal.
      signal:
        body === undefined
          ? AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
    });
    if (response.status === 401)
      throw new CredentialRejected({ cause: new Error("Microsoft refused the access token.") });
    // sendMail answers 202 with an empty body.
    const text = await response.text();
    return {
      status: response.status,
      data: text ? JSON.parse(text) : null,
      headers: { "content-type": "application/json" },
    };
  };
  return {
    operations: () => [
      {
        name: "read",
        description: "Read the Outlook profile, messages and mail folders.",
        inputSchema: z.toJSONSchema(outlookReadSchema),
      },
      {
        name: "send",
        description: "Send an exact message approved through core:outlook_send.",
        inputSchema: z.toJSONSchema(outlookSendSchema),
      },
    ],
    stop: () => lifetime.abort(),
    async invoke({ operation, input }) {
      if (operation === "read") {
        const parsed = outlookReadSchema.parse(input);
        return request(parsed.path, parsed.query);
      }
      if (operation === "send") {
        const parsed = outlookSendSchema.parse(input);
        // A queued approval must not switch senders after a disconnect/reconnect.
        const profile = await request("/v1.0/me");
        if (
          profile.status !== 200 ||
          outlookSenderAddress(profile.data) !== parsed.from.toLowerCase()
        ) {
          throw new Error("The connected Outlook sender does not match the approved From address.");
        }
        return request("/v1.0/me/sendMail", undefined, outlookSendMailBody(parsed));
      }
      throw new Error("Unsupported Outlook operation.");
    },
  };
}
