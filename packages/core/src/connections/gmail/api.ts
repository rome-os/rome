import { z } from "zod";
import { CredentialRejected } from "../errors.js";
import type { Actor, Credential, SecretRecord } from "../types.js";

const queryKeys = [
  "q",
  "pageToken",
  "maxResults",
  "labelIds",
  "format",
  "metadataHeaders",
  "includeSpamTrash",
  "fields",
] as const;
const queryValue = z.union([z.string(), z.number(), z.boolean()]);
export const gmailReadSchema = z
  .object({
    path: z
      .string()
      .regex(
        /^\/gmail\/v1\/users\/me\/(?:profile|(?:messages|threads)(?:\/(?!send$|import$|batchModify$|batchDelete$)[a-zA-Z0-9_-]+)?)$/,
      ),
    query: z.partialRecord(z.enum(queryKeys), queryValue).optional(),
    method: z.literal("GET").optional(),
    host: z.enum(["gmail.googleapis.com", "www.googleapis.com"]).optional(),
    body: z.never().optional(),
    headers: z.never().optional(),
  })
  .strict();

const email = z.email().regex(/^[^\s<>(),;:\\"\r\n]+@[^\s<>(),;:\\"\r\n]+$/);
const headerLine = z
  .string()
  .max(998)
  .refine((value) => !/[\r\n\x00-\x1f\x7f]/.test(value));
export const gmailSendSchema = z
  .object({
    connectionId: z.string().min(1),
    from: email,
    to: z.array(email).min(1).max(50),
    subject: headerLine,
    body: z.string().max(1_000_000),
    inReplyTo: headerLine.regex(/^<[^<>\s]+>$/).optional(),
    threadId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
  })
  .strict();
export type GmailSendInput = z.infer<typeof gmailSendSchema>;

export interface GmailResponse {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

/** Build only the plain-text message shown on the approval card; no caller MIME or hidden recipients. */
export function gmailRawMessage(input: GmailSendInput): string {
  const body =
    Buffer.from(input.body, "utf8")
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? "";
  const subject =
    input.subject
      .match(/.{1,10}/gsu)
      ?.map((part) => `=?UTF-8?B?${Buffer.from(part, "utf8").toString("base64")}?=`)
      .join("\r\n ") ?? "";
  return Buffer.from(
    [
      `From: ${input.from}`,
      `To: ${input.to.join(",\r\n ")}`,
      `Subject: ${subject}`,
      ...(input.inReplyTo
        ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`]
        : []),
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      body,
    ].join("\r\n"),
    "utf8",
  ).toString("base64url");
}

/** A Core-only Actor: no appAccess, no token file, and no general-purpose authenticated proxy. */
export function createGmailActor(credential: Credential): Actor {
  const lifetime = new AbortController();
  const material = async (): Promise<SecretRecord> =>
    typeof credential.material === "function" ? credential.material() : credential.material;
  const request = async (
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    raw?: string,
    threadId?: string,
  ): Promise<GmailResponse> => {
    const url = new URL(`https://gmail.googleapis.com${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    lifetime.signal.throwIfAborted();
    const token = (await material()).accessToken;
    lifetime.signal.throwIfAborted();
    if (!token) throw new Error("Google access token is unavailable.");
    const response = await fetch(url, {
      method: raw === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(raw === undefined
        ? {}
        : { body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }) }),
      redirect: "manual",
      // A send already dispatched with approval finishes across routine renewal.
      // The epoch checks above still prevent a retired Actor starting a send.
      signal:
        raw === undefined
          ? AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
    });
    if (response.status === 401)
      throw new CredentialRejected({ cause: new Error("Google refused the access token.") });
    return {
      status: response.status,
      data: await response.json(),
      headers: { "content-type": "application/json" },
    };
  };
  return {
    operations: () => [
      {
        name: "read",
        description: "Read Gmail profile, messages and threads.",
        inputSchema: z.toJSONSchema(gmailReadSchema),
      },
      {
        name: "send",
        description: "Send an exact message approved through core:gmail_send.",
        inputSchema: z.toJSONSchema(gmailSendSchema),
      },
    ],
    stop: () => lifetime.abort(),
    async invoke({ operation, input }) {
      if (operation === "read") {
        const parsed = gmailReadSchema.parse(input);
        return request(parsed.path, parsed.query);
      }
      if (operation === "send") {
        const parsed = gmailSendSchema.parse(input);
        // A queued approval must not switch senders after a disconnect/reconnect.
        const profile = await request("/gmail/v1/users/me/profile");
        if (
          profile.status !== 200 ||
          (profile.data as { emailAddress?: unknown })?.emailAddress !== parsed.from
        ) {
          throw new Error("The connected Gmail sender does not match the approved From address.");
        }
        return request(
          "/gmail/v1/users/me/messages/send",
          undefined,
          gmailRawMessage(parsed),
          parsed.threadId,
        );
      }
      throw new Error("Unsupported Gmail operation.");
    },
  };
}
