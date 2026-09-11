// The opencli boundary for the LinkedIn channel: one process runner plus the
// parsers/classifiers for the commands the channel consumes (`whoami`,
// `inbox`, `thread-snapshot`, `thread-participants`, `reply`). opencli drives Rome's
// server-side Chrome over CDP, and the LinkedIn session lives in that browser's
// profile — Rome never holds a LinkedIn credential; it holds the right to use
// the logged-in browser.
//
// Error taxonomy mirrors connections/errors.ts: an auth wall / logged-out
// session is `OpencliAuthError` (the caller maps it to CredentialRejected);
// everything else — CDP down, timeout, unparseable output — is
// `OpencliCommandError`. Polls retry transient failures. Replies require an
// explicit retry, because a lost response can follow a successful send.

import { execFile } from "node:child_process";
import { z } from "zod";

/** Raw outcome of one opencli invocation. `code` is null when the process was
 *  killed (timeout/abort) before exiting on its own. */
export interface OpencliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOpencliOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Injectable process seam: the poller, the setup, and renew() all invoke
 *  opencli through this so tests never spawn a process. */
export type RunOpencli = (args: string[], opts?: RunOpencliOptions) => Promise<OpencliResult>;

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function cdpEndpoint(): string {
  const host = process.env.ROME_CHROME_CDP_HOST ?? "127.0.0.1";
  const port = Number(process.env.ROME_CHROME_CDP_PORT ?? 9222);
  return `http://${host}:${port}`;
}

/**
 * The production runner: `opencli --cdp-endpoint <server-chrome> <args> -f json`.
 * Resolution mirrors the in-container shell alias (scripts/docker/
 * rome-shell-aliases.sh) so the channel sees the same browser agents do.
 * A non-zero exit is NOT a rejection here — callers classify via the parsers
 * below, which need the captured output either way.
 */
export function runOpencli(args: string[], opts: RunOpencliOptions = {}): Promise<OpencliResult> {
  const bin = process.env.ROME_OPENCLI_BIN ?? "opencli";
  const fullArgs = ["--cdp-endpoint", cdpEndpoint(), ...args, "-f", "json"];
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      fullArgs,
      {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
          // Spawn-level failure (ENOENT, EACCES): the binary itself is missing,
          // which no amount of output classification can improve on.
          reject(new Error(`${bin} could not be run: ${error.message}`));
          return;
        }
        const exitCode = error
          ? typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code?: number }).code ?? null)
            : null
          : 0;
        resolve({ code: exitCode, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/**
 * Open a page in the server-side Chrome the LinkedIn session lives in (the
 * same PUT-then-GET dance as api/routes/desktop.ts `openServerBrowserTab`,
 * kept local so the connection layer does not reach into an HTTP route
 * module). Best-effort: the setup shows manual instructions either way.
 */
export async function openLinkedInBrowserTab(url: string): Promise<boolean> {
  const target = `${cdpEndpoint()}/json/new?${encodeURIComponent(url)}`;
  for (const method of ["PUT", "GET"] as const) {
    try {
      const res = await fetch(target, { method, signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** The signed-out signal: the caller maps this to CredentialRejected. */
export class OpencliAuthError extends Error {
  constructor(detail: string) {
    super(`LinkedIn browser session is not signed in: ${detail}`);
    this.name = "OpencliAuthError";
  }
}

/** Any non-auth failure: transient, retried on the next poll. */
export class OpencliCommandError extends Error {
  constructor(command: string, detail: string) {
    super(`opencli ${command} failed: ${detail}`);
    this.name = "OpencliCommandError";
  }
}

// opencli prints structured errors (code/message/help) on failure; these
// markers cover both its typed AuthRequiredError surface and the plugin's
// auth-wall phrasing (opencli-plugins/linkedin/thread-snapshot.js).
const AUTH_MARKERS = /auth[\s_-]?required|authwall|auth wall|signed-in linkedin|not logged in/i;

function failureDetail(result: OpencliResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  const firstLines = text.split("\n").slice(0, 6).join(" ").slice(0, 500);
  return firstLines || `exit code ${result.code ?? "none (killed)"}`;
}

/** Classify a non-zero exit into auth vs transient and throw accordingly. */
function throwForFailure(command: string, result: OpencliResult): never {
  const text = `${result.stderr}\n${result.stdout}`;
  if (AUTH_MARKERS.test(text)) throw new OpencliAuthError(failureDetail(result));
  throw new OpencliCommandError(command, failureDetail(result));
}

function parseJsonOutput(command: string, result: OpencliResult): unknown {
  if (result.code !== 0) throwForFailure(command, result);
  const trimmed = result.stdout.trim();
  if (!trimmed) throw new OpencliCommandError(command, "produced no output");
  try {
    return JSON.parse(trimmed);
  } catch {
    // Errors sometimes print as YAML even under -f json; classify them too.
    if (AUTH_MARKERS.test(trimmed)) throw new OpencliAuthError(failureDetail(result));
    throw new OpencliCommandError(command, `unparseable output: ${trimmed.slice(0, 200)}`);
  }
}

// ── whoami ────────────────────────────────────────────────────────────────

const whoamiSchema = z.object({
  logged_in: z.boolean(),
  public_id: z.string().optional(),
  plain_id: z.string().optional(),
  name: z.string().optional(),
});

export interface LinkedInWhoami {
  publicId?: string;
  plainId?: string;
  name?: string;
}

/** Parse `linkedin whoami`. A clean `logged_in: false` is an auth error — the
 *  command ran fine, the session is simply signed out. */
export function parseWhoami(result: OpencliResult): LinkedInWhoami {
  const parsed = whoamiSchema.safeParse(parseJsonOutput("linkedin whoami", result));
  if (!parsed.success) {
    throw new OpencliCommandError("linkedin whoami", "unexpected output shape");
  }
  if (!parsed.data.logged_in) throw new OpencliAuthError("whoami reports logged_in: false");
  return {
    ...(parsed.data.public_id ? { publicId: parsed.data.public_id } : {}),
    ...(parsed.data.plain_id ? { plainId: parsed.data.plain_id } : {}),
    ...(parsed.data.name ? { name: parsed.data.name } : {}),
  };
}

// ── inbox ─────────────────────────────────────────────────────────────────

const inboxRowSchema = z.object({
  rank: z.number().optional(),
  thread_url: z.string().min(1),
  thread_id: z.string().min(1),
  person_name: z.string().nullish(),
  last_message_preview: z.string().nullish(),
  unread: z.boolean().optional(),
  counterparty_type: z.string().nullish(),
  category: z.string().nullish(),
  timestamp: z.string().nullish(),
});

export interface LinkedInInboxRow {
  rank: number;
  threadId: string;
  threadUrl: string;
  personName: string | null;
  lastMessagePreview: string | null;
  unread: boolean;
  counterpartyType: string | null;
  category: string | null;
  lastMessageAt: Date | null;
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function parseInbox(result: OpencliResult): LinkedInInboxRow[] {
  const raw = parseJsonOutput("linkedin inbox", result);
  const rows = z.array(inboxRowSchema).safeParse(raw);
  if (!rows.success) throw new OpencliCommandError("linkedin inbox", "unexpected output shape");
  return rows.data.map((row, index) => ({
    rank: row.rank ?? index + 1,
    threadId: row.thread_id,
    threadUrl: row.thread_url,
    personName: row.person_name ?? null,
    lastMessagePreview: row.last_message_preview ?? null,
    unread: row.unread ?? false,
    counterpartyType: row.counterparty_type ?? null,
    category: row.category ?? null,
    lastMessageAt: parseIsoDate(row.timestamp),
  }));
}

// ── thread-snapshot ───────────────────────────────────────────────────────
// The Rome override's per-message rows (opencli-plugins/linkedin/
// thread-snapshot.js), not the upstream page-scrape summary.

const snapshotRowSchema = z.object({
  thread_id: z.string().min(1),
  conversation_name: z.string().nullish(),
  // Authoritative group metadata (plugin ≥0.2.0). Optional so rows from an
  // older installed plugin still parse — absent reads as "unknown", never as
  // a 1:1 verdict.
  conversation_title: z.string().nullish(),
  conversation_is_group: z.boolean().nullish(),
  participant_count: z.number().nullish(),
  message_id: z.string().min(1),
  sent_at: z.string().nullish(),
  sender_participant_id: z.string().nullish(),
  sender_name: z.string().nullish(),
  sender_type: z.string().nullish(),
  sender_profile_url: z.string().nullish(),
  sender_headline: z.string().nullish(),
  sender_is_self: z.boolean().optional(),
  text: z.string().nullish(),
  subject: z.string().nullish(),
  reaction_count: z.number().nullish(),
});

export interface LinkedInSnapshotMessage {
  threadId: string;
  /** Display ladder (title, else joined counterparty names) — NOT a group signal. */
  conversationName: string | null;
  /** The raw conversation title only; null for 1:1 and untitled threads. */
  conversationTitle: string | null;
  /** LinkedIn's own group flag; null when the installed plugin predates it. */
  conversationIsGroup: boolean | null;
  /**
   * What the snapshot page claimed, reported as the plugin sends it. The
   * mirror does not store this: the count a reader sees is counted from the
   * membership `linkedin thread-participants` reads, so a thread has exactly
   * one answer to how many people are on it.
   */
  participantCount: number | null;
  messageId: string;
  sentAt: Date | null;
  senderParticipantId: string | null;
  senderName: string | null;
  senderType: string | null;
  senderProfileUrl: string | null;
  senderHeadline: string | null;
  senderIsSelf: boolean;
  text: string | null;
  subject: string | null;
  reactionCount: number | null;
}

export function parseThreadSnapshot(result: OpencliResult): LinkedInSnapshotMessage[] {
  const raw = parseJsonOutput("linkedin thread-snapshot", result);
  const rows = z.array(snapshotRowSchema).safeParse(raw);
  if (!rows.success) {
    throw new OpencliCommandError("linkedin thread-snapshot", "unexpected output shape");
  }
  return rows.data.map((row) => ({
    threadId: row.thread_id,
    conversationName: row.conversation_name ?? null,
    conversationTitle: row.conversation_title || null,
    conversationIsGroup: row.conversation_is_group ?? null,
    participantCount: row.participant_count ?? null,
    messageId: row.message_id,
    sentAt: parseIsoDate(row.sent_at),
    senderParticipantId: row.sender_participant_id || null,
    senderName: row.sender_name ?? null,
    senderType: row.sender_type ?? null,
    senderProfileUrl: row.sender_profile_url ?? null,
    senderHeadline: row.sender_headline ?? null,
    senderIsSelf: row.sender_is_self ?? false,
    text: row.text ?? null,
    subject: row.subject ?? null,
    reactionCount: row.reaction_count ?? null,
  }));
}

/** A reply receipt must carry the same provider id as the history mirror. */
export function parseLinkedInReply(
  result: OpencliResult,
  threadId: string,
): LinkedInSnapshotMessage {
  if (result.code === null) {
    throw new OpencliCommandError(
      "linkedin reply",
      "Send outcome is unknown. Check LinkedIn before retrying.",
    );
  }
  let raw: unknown;
  try {
    raw = parseJsonOutput("linkedin reply", result);
  } catch (error) {
    if (error instanceof OpencliAuthError || result.code !== 0) throw error;
    throw new OpencliCommandError(
      "linkedin reply",
      "Send outcome is unknown. Check LinkedIn before retrying.",
    );
  }
  const parsed = z
    .array(
      snapshotRowSchema.extend({
        status: z.literal("sent"),
        sender_is_self: z.literal(true),
      }),
    )
    .length(1)
    .safeParse(raw);
  if (!parsed.success || parsed.data[0]?.thread_id !== threadId) {
    throw new OpencliCommandError(
      "linkedin reply",
      "Send outcome is unknown. Check LinkedIn before retrying.",
    );
  }
  const [message] = parseThreadSnapshot(result);
  if (!message?.sentAt) {
    throw new OpencliCommandError(
      "linkedin reply",
      "Send outcome is unknown. Check LinkedIn before retrying.",
    );
  }
  return message;
}

// ── thread-participants ───────────────────────────────────────────────────
// The Rome-owned command (opencli-plugins/linkedin/thread-participants.js).
// It reads the conversation's participant reference list, so it names everyone
// on the thread — including members who have never sent a message, who are
// invisible in `thread-snapshot`'s per-message rows.

const participantRowSchema = z.object({
  thread_id: z.string().min(1),
  participant_id: z.string(),
  name: z.string().nullish(),
  headline: z.string().nullish(),
  type: z.string().nullish(),
  is_self: z.boolean(),
  profile_url: z.string().nullish(),
});

export interface LinkedInThreadParticipant {
  threadId: string;
  /** LinkedIn's obfuscated member id, bare (`ACoAA…`). */
  participantId: string;
  name: string | null;
  headline: string | null;
  /** `member` | `organization` | `agent` | `custom`. */
  type: string | null;
  /** True for the account owner's own row in the participant list. */
  isSelf: boolean;
  profileUrl: string | null;
}

/** The plugin writes "" for a field it could not read; the mirror stores "not
 *  known" as null so a later read can still fill it in. */
function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Parse `linkedin thread-participants`. Rows without a member id are dropped
 * rather than stored as a blank account — `participant_id` is the primary key
 * of `linkedin_participants` and has to match `channel_mappings.channel_user_id`.
 *
 * An empty result is a failure, not an empty thread: the store reads an empty
 * participant set as "everyone left" and would wipe the thread's membership,
 * so a read that proved nothing must never reach it.
 */
export function parseThreadParticipants(result: OpencliResult): LinkedInThreadParticipant[] {
  const raw = parseJsonOutput("linkedin thread-participants", result);
  const rows = z.array(participantRowSchema).safeParse(raw);
  if (!rows.success) {
    throw new OpencliCommandError("linkedin thread-participants", "unexpected output shape");
  }
  const participants = rows.data
    .filter((row) => row.participant_id.trim() !== "")
    .map((row) => ({
      threadId: row.thread_id,
      participantId: row.participant_id.trim(),
      name: emptyToNull(row.name),
      headline: emptyToNull(row.headline),
      type: emptyToNull(row.type),
      isSelf: row.is_self,
      profileUrl: emptyToNull(row.profile_url),
    }));
  if (participants.length === 0) {
    throw new OpencliCommandError("linkedin thread-participants", "reported no participants");
  }
  return participants;
}

/** Read one thread's full participant list through opencli. */
export async function readLinkedInThreadParticipants(
  input: { threadUrl: string },
  run: RunOpencli = runOpencli,
  opts: RunOpencliOptions = {},
): Promise<LinkedInThreadParticipant[]> {
  const result = await run(
    ["linkedin", "thread-participants", "--thread-url", input.threadUrl],
    opts,
  );
  return parseThreadParticipants(result);
}
