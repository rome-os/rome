import type { TFunction } from "i18next";
import type {
  CreatePersonRequest,
  DirectoryAccount,
  LinkAccountRequest,
  LinkConflict,
  OutboxMessage,
  PersonResource,
  SendMessageRequest,
  SendRefusal,
  UpdatePersonRequest,
} from "@rome/api-types/people";

// The People page's writes, at the wire: one function per verb of the /people
// contract (@rome/api-types/people), and no view logic. What each verb means,
// when it refuses and what a refusal carries are the contract's; this module
// only names the route and reduces the answer to something a click handler can
// render.
//
// An account is named by the pair the contract names it with, never by
// one of the addresses it answers to. The server folds a WhatsApp contact's
// phone jid and `@lid` jid into one account and reports both in `addresses`, so
// a gesture on a row already covers every address it stands for — the reason
// none of these takes a list.

/** An account, named the way every verb here names one. */
export interface AccountRef {
  channel: string;
  channelUserId: string;
}

/**
 * What a write answers.
 *
 * A conflict is its own outcome rather than an error string: the caller has to
 * act on what the refusal named — the person who holds the account, or which of
 * the ways a channel cannot be written to — and a sentence it would have to
 * parse is neither a person's id nor a send state.
 *
 * `C` is which 409 this verb can earn. It defaults to {@link LinkConflict},
 * which is every verb that moves a link; a send earns a {@link SendRefusal}
 * instead, and typing the pair together would leave each caller narrowing away
 * a refusal its route cannot answer with.
 */
export type WriteOutcome<T, C = LinkConflict> =
  | { ok: true; value: T }
  | { ok: false; conflict: C }
  | {
      ok: false;
      message: string;
      /**
       * What the server answered, absent when nothing was reached.
       *
       * Beside the message rather than instead of it: every caller has a line
       * to render and most have nothing to say about the code. It is here for
       * the ones that do — a 404 on an outbox gesture means the row is not
       * this reader's to act on, which is a different thing from a write that
       * failed, and only the status tells the two apart.
       */
      status?: number;
    };

function isLinkConflict(payload: unknown): payload is LinkConflict {
  if (typeof payload !== "object" || payload === null) return false;
  const body = payload as Record<string, unknown>;
  return typeof body.channel === "string" && typeof body.channelUserId === "string";
}

/** A 409 from the send route: which of the three ways the channel could not be
 *  written to. `error` is a fallback line; the dashboard renders `send`. */
function isSendRefusal(payload: unknown): payload is SendRefusal {
  if (typeof payload !== "object" || payload === null) return false;
  const send = (payload as Record<string, unknown>).send;
  return send === "not-connected" || send === "unsupported" || send === "no-conversation";
}

/**
 * The path an account occupies, escaped, with its own separators left in place.
 *
 * The routes take the rest of the path as the identifier: a channel mints its
 * own addresses and channels are open — a Rome App brings one — so nothing
 * promises they avoid "/", and a percent-escaped one would name a segment the
 * route never sees.
 */
function accountPath(account: AccountRef): string {
  const identifier = account.channelUserId.split("/").map(encodeURIComponent).join("/");
  return `${encodeURIComponent(account.channel)}/${identifier}`;
}

/**
 * Send one write and reduce whatever comes back. Never throws — every caller is
 * an event handler, where an unhandled rejection leaves the gesture silent.
 *
 * Only a 4xx body is treated as copy. These routes answer a rejected request
 * with an `{ error }` naming what is wrong with it, which is what the guardian
 * needs. A 5xx body carries the same shape and not the same meaning: the API
 * error handler serializes an unhandled exception as `{ error: err.message }`,
 * so trusting it would put a raw SQLite or repository message on screen.
 */
async function send<T, C = LinkConflict>(
  url: string,
  init: { method: string; json?: unknown },
  t: TFunction<"people">,
  /** Read a 409 body as this verb's conflict, or null when it is not one.
   *  Defaults to the link conflict every account-moving verb answers with. */
  readConflict: (payload: unknown) => C | null = (payload) =>
    isLinkConflict(payload) ? (payload as C) : null,
): Promise<WriteOutcome<T, C>> {
  const response = await fetch(url, {
    method: init.method,
    credentials: "include",
    cache: "no-store",
    ...(init.json === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.json) }),
  }).catch(() => null);

  if (!response) return { ok: false, message: t("errors.network") };
  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) return { ok: true, value: payload as T };
  if (response.status === 409) {
    const conflict = readConflict(payload);
    if (conflict !== null) return { ok: false, conflict };
  }
  const status = response.status;
  if (status >= 500) return { ok: false, message: t("errors.requestFailed"), status };
  const error = (payload as { error?: unknown } | null)?.error;
  return {
    ok: false,
    message: typeof error === "string" && error !== "" ? error : t("errors.requestFailed"),
    status,
  };
}

/** `POST /api/people`. Both-or-neither: a create naming an account somebody
 *  holds refuses whole, so a person never exists without the account that was
 *  the reason to create them. */
export function createPerson(
  request: CreatePersonRequest,
  t: TFunction<"people">,
): Promise<WriteOutcome<PersonResource>> {
  return send("/api/people", { method: "POST", json: request }, t);
}

/** `POST /api/people/:id/accounts`. `transferFrom` names the person the account
 *  is taken from, and is what makes a transfer something the guardian asked
 *  for rather than the side effect of a retry. */
export function linkAccount(
  personId: string,
  request: LinkAccountRequest,
  t: TFunction<"people">,
): Promise<WriteOutcome<PersonResource>> {
  return send(
    `/api/people/${encodeURIComponent(personId)}/accounts`,
    { method: "POST", json: request },
    t,
  );
}

/**
 * `DELETE /api/people/:id/accounts/:channel/:channelUserId`.
 *
 * No gesture calls this yet — the row menu that would is still ahead. It sits
 * here because this module is the contract's verbs and a wire missing one reads
 * as a verb that does not exist; `./use-writes.ts` carries only the gestures the
 * page has.
 */
export function unlinkAccount(
  personId: string,
  account: AccountRef,
  t: TFunction<"people">,
): Promise<WriteOutcome<PersonResource>> {
  return send(
    `/api/people/${encodeURIComponent(personId)}/accounts/${accountPath(account)}`,
    { method: "DELETE" },
    t,
  );
}

/** `POST /api/accounts/:channel/:channelUserId/dismiss`. Dismissal is a state
 *  the account is in, not a merge into a sentinel, so {@link restoreAccount} is
 *  the whole way back. */
export function dismissAccount(
  account: AccountRef,
  t: TFunction<"people">,
): Promise<WriteOutcome<DirectoryAccount>> {
  return send(`/api/accounts/${accountPath(account)}/dismiss`, { method: "POST" }, t);
}

/** `POST /api/accounts/:channel/:channelUserId/restore`. */
export function restoreAccount(
  account: AccountRef,
  t: TFunction<"people">,
): Promise<WriteOutcome<DirectoryAccount>> {
  return send(`/api/accounts/${accountPath(account)}/restore`, { method: "POST" }, t);
}

/** `POST /api/people/:id/merge`. The survivor is named in the path and the
 *  duplicate in the body: every link transfers atomically, then the duplicate
 *  is gone. */
export function mergePeople(
  into: string,
  from: string,
  t: TFunction<"people">,
): Promise<WriteOutcome<PersonResource>> {
  return send(
    `/api/people/${encodeURIComponent(into)}/merge`,
    { method: "POST", json: { from } },
    t,
  );
}

/** `PATCH /api/people/:id`. An omitted field is one the update leaves alone, so
 *  a bond change carries the bond and nothing else. */
export function updatePerson(
  personId: string,
  update: UpdatePersonRequest,
  t: TFunction<"people">,
): Promise<WriteOutcome<PersonResource>> {
  return send(`/api/people/${encodeURIComponent(personId)}`, { method: "PATCH", json: update }, t);
}

/**
 * `POST /api/people/:id/messages`. The account is in the body, always — the
 * contract has no shape of this request that omits it.
 *
 * Answers the outbox row the send became, never a delivered message: the
 * channel taking a message is not the message arriving, and only a later read
 * of the outbox can see the second one.
 */
export function sendMessage(
  personId: string,
  request: SendMessageRequest,
  t: TFunction<"people">,
): Promise<WriteOutcome<OutboxMessage, SendRefusal>> {
  return send(
    `/api/people/${encodeURIComponent(personId)}/messages`,
    { method: "POST", json: request },
    t,
    (payload) => (isSendRefusal(payload) ? payload : null),
  );
}

/** `POST /api/people/:id/outbox/:messageId/retry`. Under the failed row's own
 *  id, so a retry never reads as a second message the guardian did not write. */
export function retrySend(
  personId: string,
  messageId: string,
  t: TFunction<"people">,
): Promise<WriteOutcome<OutboxMessage>> {
  return send(
    `/api/people/${encodeURIComponent(personId)}/outbox/${encodeURIComponent(messageId)}/retry`,
    { method: "POST" },
    t,
  );
}

/** `DELETE /api/people/:id/outbox/:messageId`. The only way a row leaves the
 *  outbox without having been delivered. */
export function discardSend(
  personId: string,
  messageId: string,
  t: TFunction<"people">,
): Promise<WriteOutcome<void>> {
  return send(
    `/api/people/${encodeURIComponent(personId)}/outbox/${encodeURIComponent(messageId)}`,
    { method: "DELETE" },
    t,
  );
}
