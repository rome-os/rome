import { http, HttpResponse } from "msw";
import { STRANGER_PERSON_ID, protectedPersonReason } from "@rome/api-types/persons";
import {
  accountPresentation,
  comparePeople,
  countPeople,
  isAfterTimelineCursor,
  isAssignableBondLevel,
  latestDynamic,
  parseAccountCursor,
  parseAccountState,
  parseStreamCursor,
  parseMergeRequest,
  parsePersonFilterLevel,
  parseSendMessageRequest,
  parseTimelineCursor,
  parseUpdatePersonRequest,
  personMatchesLevel,
  personMatchesQuery,
  sliceAccountDirectory,
  sliceAccountStream,
  timelineCursor,
  timelinePageLimit,
  type CreatePersonRequest,
  type DirectoryAccount,
  type LinkAccountRequest,
  type LinkConflict,
  type AccountSendState,
  type AccountState,
  type OutboxMessage,
  type OutboxPage,
  type PeopleList,
  type PersonResource,
  type SendRefusal,
  type StreamAccount,
  type TimelineEntry,
  type TimelinePage,
} from "@rome/api-types/people";
import { talkConnections } from "./connections-store";
import { memoryProfilePath } from "./memory-files";
import {
  accountTimeline,
  nameForAccount,
  nextPersonId,
  ownerOf,
  personTimeline,
  persons,
  recordDelivered,
  sentinelSenders,
  whatsappContacts,
  type AccountRef,
} from "./people";

/**
 * The /people contract — Person, Account, Link — over the fixture store in
 * ./people.ts, so a link made here is visible to the channel thread the mirror
 * endpoints open. Wire types and route map: `@rome/api-types/people`;
 * vocabulary: docs/concepts/people.md.
 *
 * Mock mode's implementation of the same surface core serves
 * (`packages/core/src/api/routes/people.ts` and `.../accounts.ts`), typed
 * against the contract module like every other handler here, so the dashboard
 * cannot be built against a shape production does not answer with.
 *
 * The stranger sentinel is implementation, not contract: dismissal is stored
 * as a link to the sentinel row, presented as `state: "dismissed"` through
 * `accountPresentation`, and no /api/people route addresses the sentinel.
 */

/**
 * Whether Rome can send on a channel, as the real read answers it.
 *
 * Production asks the live connection in two steps, and this asks the same two
 * against the fixture ledger. No connection for the channel is `not-connected`
 * — the ledger is `./connections-store.ts`, so revoking a grant on the
 * Connections page relocks talk and this read notices, the way the real one
 * does. A connection whose talker does not do direct messaging is
 * `unsupported`, which in the first cut is every channel but the two.
 *
 * `no-conversation` is unreachable here, as it is on those two channels in
 * production: their address already names the conversation. A channel that
 * keys threads separately would answer it, and the dashboard renders it —
 * `../../src/pages/people/send-copy.ts` carries the copy for all three.
 */
function sendState(channel: string): AccountSendState {
  if (talkConnections(channel).length === 0) return "not-connected";
  return channel === "whatsapp" || channel === "telegram" ? "yes" : "unsupported";
}

type PersonFixture = (typeof persons)[number];

function personResource(person: PersonFixture): PersonResource {
  const entries = personTimeline(person.id) ?? [];
  return {
    id: person.id,
    displayName: person.displayName,
    bondLevel: person.bondLevel,
    accounts: person.channelMappings.map((a) => ({
      channel: a.channel,
      channelUserId: a.channelUserId,
      displayName: nameForAccount(a.channel, a.channelUserId),
      send: sendState(a.channel),
      // The account's own head, not the person's: the person's newest entry
      // names a channel and not an address, so it cannot say which of two
      // accounts on one channel was the recent one.
      latestAt: accountTimeline(a)[0]?.timestamp ?? null,
    })),
    // Timeline entries, not records: the contract pins a person's count to the
    // history GET /api/people/:id/messages pages.
    messageCount: entries.length,
    latest: latestDynamic(entries),
    // Read off the memory tree (./memory-files.ts) rather than a list here, so
    // the dossier only offers the link for a profile the Memory page can open.
    // Not everyone has one, because nothing writes a profile when a person is
    // created: both states the dossier's menu handles are on the fixtures.
    memoryPath: memoryProfilePath(person.id),
  };
}

/** A contacts-list row: who the account is, and nothing about what was said. */
function directoryRow(ref: AccountRef): DirectoryAccount {
  const owner = ownerOf(ref.channel, ref.channelUserId);
  return {
    channel: ref.channel,
    channelUserId: ref.channelUserId,
    addresses: [ref.channelUserId],
    displayName: nameForAccount(ref.channel, ref.channelUserId),
    ...accountPresentation(owner ? { personId: owner.id, displayName: owner.displayName } : null),
  };
}

/** The same account on the recents surface, or null when nothing has happened
 *  on it — the stream carries no such account. */
function streamRow(ref: AccountRef): StreamAccount | null {
  const latest = latestDynamic(accountTimeline(ref));
  return latest == null ? null : { ...directoryRow(ref), latest };
}

/** Every account the three sources name, once each — what both account reads
 *  are cut out of. */
function observedAccounts(): AccountRef[] {
  const seen = new Map<string, AccountRef>();
  const add = (channel: string, channelUserId: string) => {
    seen.set(`${channel}\n${channelUserId}`, { channel, channelUserId });
  };
  for (const p of persons) for (const m of p.channelMappings) add(m.channel, m.channelUserId);
  for (const s of sentinelSenders) add(s.channel, s.channelUserId);
  for (const c of whatsappContacts) if (!c.isGroup) add("whatsapp", c.jid);
  return [...seen.values()];
}

/** The `?state=` both account reads narrow by, or the 400 a value naming no
 *  state earns. */
function readState(params: URLSearchParams): { state: AccountState | null } | { error: Response } {
  const raw = params.get("state");
  const state = parseAccountState(raw);
  if (raw != null && raw !== "" && state === null) {
    return {
      error: HttpResponse.json(
        { error: "state must be unlinked, linked, or dismissed" },
        { status: 400 },
      ),
    };
  }
  return { state };
}

/** The sentinel is structure: no /api/people route resolves it. */
const findVisiblePerson = (id: string) =>
  id === STRANGER_PERSON_ID ? undefined : persons.find((p) => p.id === id);

const strangerRow = () => persons.find((p) => p.id === STRANGER_PERSON_ID);

const notFound = (what: string) => HttpResponse.json({ error: `Unknown ${what}` }, { status: 404 });

/** What both outbox mutations answer for a row that is not this person's failed
 *  row. One reply for "no such row", "not yours" and "already claimed": the
 *  caller re-reads the outbox either way, and telling them apart would be
 *  telling a caller about somebody else's rows. */
const notTheirs = () =>
  HttpResponse.json({ error: "No failed message of theirs with that id" }, { status: 404 });

const linkConflict = (ref: AccountRef, owner: { id: string; displayName: string }) =>
  ({
    error: "account is already linked to another person",
    channel: ref.channel,
    channelUserId: ref.channelUserId,
    linkedPersonId: owner.id,
    linkedPersonName: owner.displayName,
  }) satisfies LinkConflict;

/**
 * The link verb, shared by create and POST :id/accounts. Compare-and-swap on
 * the current owner: `transferFrom` must name it exactly for a takeover, and
 * an unlinked or dismissed account links without one — dismissal is
 * bookkeeping, not ownership, so linking silently displaces it.
 */
function link(
  person: PersonFixture,
  ref: AccountRef,
  transferFrom: string | undefined,
): { ok: true } | { status: number; body: Record<string, unknown> } {
  const owner = ownerOf(ref.channel, ref.channelUserId);
  if (owner?.id === person.id) return { ok: true }; // idempotent re-link
  if (owner && owner.id !== STRANGER_PERSON_ID && owner.id !== transferFrom) {
    return { status: 409, body: linkConflict(ref, owner) };
  }
  if (transferFrom && owner?.id !== transferFrom && owner?.id !== STRANGER_PERSON_ID) {
    return {
      status: 409,
      body: {
        error: "transferFrom does not match the account's current owner",
        linkedPersonId: owner && owner.id !== STRANGER_PERSON_ID ? owner.id : null,
      },
    };
  }
  if (owner) {
    owner.channelMappings = owner.channelMappings.filter(
      (m) => !(m.channel === ref.channel && m.channelUserId === ref.channelUserId),
    );
  }
  person.channelMappings.push({ channel: ref.channel, channelUserId: ref.channelUserId });
  return { ok: true };
}

const refFromParams = (params: Record<string, unknown>): AccountRef => ({
  channel: String(params.channel),
  channelUserId: decodeURIComponent(String(params.channelUserId)),
});

// ---------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------

/**
 * Sends Rome has been asked to make and has not seen arrive.
 *
 * Nothing here clears a row. A row is gone once its message is on the timeline,
 * and {@link readOutbox} is what notices — the same derivation the route runs,
 * so a dashboard built against this cannot come to depend on a delivery
 * callback production does not send.
 *
 * A real channel answers on its own schedule; this one answers on the clock,
 * because a mock with no provider behind it has nothing else to wait for. The
 * two waits are what make `sending` and `unconfirmed` visible states rather
 * than a flicker nobody can look at.
 */
interface OutboxRow extends OutboxMessage {
  /** When the current attempt started, in ms. A retry resets it, so the row
   *  walks the same two stages again. */
  attemptedAt: number;
  attempts: number;
}

const outbox: OutboxRow[] = [];

/** How long the channel takes to accept a message, and how long after that it
 *  surfaces in the store the timeline reads. */
const ACCEPTED_AFTER_MS = 700;
const LANDS_AFTER_MS = 1_400;

/** How long a row may sit unconfirmed before it counts as stuck. The route's
 *  five minutes; a mock row lands in under two seconds, so anything still here
 *  after this has been deliberately wedged. */
const STRANDED_AFTER_MS = 5 * 60_000;

/**
 * The fallback line on a refusal, in the route's own words.
 *
 * A fallback and not the copy: the dashboard keys off `send` and owns every
 * sentence a reader sees, which is what lets the refusal localize. Kept
 * identical to the route's so nothing can come to depend on the difference.
 */
function refusalMessage(send: Exclude<AccountSendState, "yes">): string {
  switch (send) {
    case "not-connected":
      return "That channel is not connected";
    case "unsupported":
      return "Rome cannot send on that channel";
    case "no-conversation":
      return "Rome has no conversation open with that account";
  }
}

/**
 * The server's own line for a send whose process died before the channel
 * answered. Not a provider message, and deliberately equivocal — Rome does not
 * know whether it went out. Kept identical to `people/outbox.ts`'s, so the
 * dashboard is exercised against the text production actually sends.
 */
const STRANDED_ERROR =
  "Rome stopped before the channel answered; this may or may not have been sent";

/**
 * Why this attempt stops, or null when it goes through.
 *
 * Text-triggered, because nothing else in mock mode can go wrong: there is no
 * provider to be down and no process to die. `fail` stops only the first
 * attempt, so Retry has something to succeed at — the gesture is the point of
 * the state. `stranded` keeps answering the same way, because it stands in for
 * a row nothing will ever move.
 */
function stops(row: OutboxRow): string | null {
  const text = row.text.toLowerCase();
  if (text.startsWith("stranded")) return STRANDED_ERROR;
  if (text.startsWith("fail") && row.attempts === 1) return "the channel rejected this message";
  return null;
}

/**
 * A send the channel took and whose message never reaches the timeline.
 *
 * The phantom Discard exists for: on a channel with no mirror of its own,
 * Rome's transcript write is how a sent message lands, so a write that failed
 * leaves a row nothing will ever move. Text-triggered, because a mock has no
 * transcript to fail. Its row is backdated past the landing window on the way
 * to `unconfirmed`, since nobody is going to sit here for five minutes to watch
 * a button appear.
 */
function wedges(row: OutboxRow): boolean {
  return row.text.toLowerCase().startsWith("wedged");
}

/**
 * This person's row with that id, or null.
 *
 * Both outbox mutations resolve their row through this, because both are scoped
 * the same way: a message id is not a capability, and the person in the path is
 * whose outbox it is. Which states each verb then accepts is its own question,
 * and the two answers differ.
 */
function rowOf(person: PersonFixture, messageId: string): OutboxRow | null {
  const row = outbox.find((candidate) => candidate.id === messageId);
  if (!row) return null;
  const held = person.channelMappings.some(
    (m) => m.channel === row.channel && m.channelUserId === row.channelUserId,
  );
  return held ? row : null;
}

/**
 * Whether a row can be given up on: the route's rule, kept here so the mock and
 * production never disagree about whether a button works.
 *
 * A row is dismissable once nothing is going to happen to it on its own. A
 * `failed` one is finished. An `unconfirmed` one inside the landing window is
 * ordinary and about to clear itself, so dropping it would race the clearing;
 * past the window it was delivered and will never be seen, and on a channel
 * with no mirror of its own that is the only way out it has. A `sending` one
 * has not been answered yet.
 */
function isDismissableRow(row: OutboxRow, now: number): boolean {
  if (row.state === "failed") return true;
  return row.state === "unconfirmed" && now - row.attemptedAt >= STRANDED_AFTER_MS;
}

function openRow(account: AccountRef, text: string): OutboxRow {
  const row: OutboxRow = {
    id: crypto.randomUUID(),
    channel: account.channel,
    channelUserId: account.channelUserId,
    text,
    timestamp: Math.floor(Date.now() / 1000),
    state: "sending",
    ref: null,
    error: null,
    attemptedAt: Date.now(),
    attempts: 1,
  };
  outbox.push(row);
  return row;
}

/** The wire shape: the row minus the bookkeeping that drives the mock's clock,
 *  which is not on the contract. */
function outboxMessage(row: OutboxRow): OutboxMessage {
  const { attemptedAt: _at, attempts: _n, ...message } = row;
  return message;
}

/**
 * This person's outbox, after moving every row as far as its clock allows.
 *
 * Two steps, in the order the real one takes them. First each attempt resolves:
 * accepted and named, or refused. Then a message that has surfaced clears its
 * row — by looking its `ref` up on the timeline, never by a flag, because that
 * comparison is what the contract says an outbox row *is*.
 */
function readOutbox(person: PersonFixture): OutboxMessage[] {
  const now = Date.now();
  const held = (row: OutboxRow) =>
    person.channelMappings.some(
      (m) => m.channel === row.channel && m.channelUserId === row.channelUserId,
    );

  for (const row of outbox.filter(held)) {
    const elapsed = now - row.attemptedAt;
    if (row.state === "sending" && elapsed >= ACCEPTED_AFTER_MS) {
      const stopped = stops(row);
      if (stopped !== null) {
        row.state = "failed";
        row.error = stopped;
      } else {
        row.state = "unconfirmed";
        // The id the channel gives back. A hint at the entry this would become
        // at the address it was sent to, not a key: the server recognizes an
        // arrival across every address the account folds, and this is the mock
        // playing server rather than anything a client may rely on.
        row.ref = `${row.channelUserId}:${row.id}`;
        if (wedges(row)) {
          // Backdated on the wire as well as in the bookkeeping. The row stands
          // in for one accepted five minutes ago, and a reader decides whether
          // to offer Discard from `timestamp` — the only age the contract
          // carries. A row old to the route and fresh to the client would be a
          // button that looks wrong rather than a state worth looking at.
          row.attemptedAt = now - STRANDED_AFTER_MS;
          row.timestamp = Math.floor((now - STRANDED_AFTER_MS) / 1000);
        }
      }
    }
    if (
      row.state === "unconfirmed" &&
      elapsed >= LANDS_AFTER_MS &&
      row.ref !== null &&
      !wedges(row)
    ) {
      recordDelivered(row, { timestamp: row.timestamp, body: row.text, ref: row.ref });
    }
  }

  const arrived = new Set((personTimeline(person.id) ?? []).map((entry) => entry.ref));
  for (let i = outbox.length - 1; i >= 0; i -= 1) {
    const row = outbox[i]!;
    if (held(row) && row.state === "unconfirmed" && row.ref !== null && arrived.has(row.ref)) {
      outbox.splice(i, 1);
    }
  }

  return outbox.filter(held).map(outboxMessage);
}

export const peopleHandlers = [
  // Curated people only — the sentinel's holdings surface on /api/accounts as
  // dismissed rows, never as a person.
  http.get("/api/people", ({ request }) => {
    const params = new URL(request.url).searchParams;
    const q = (params.get("q") ?? "").trim();
    const rawLevel = params.get("level");
    const level = parsePersonFilterLevel(rawLevel);
    if (rawLevel != null && rawLevel !== "" && level === null) {
      return HttpResponse.json({ error: `level must name a bond level or "all"` }, { status: 400 });
    }
    // Counts cover everything the query matches; `?level=` narrows the rows
    // alone, so every chip keeps its number while one is selected.
    const matching = persons
      .filter((p) => p.id !== STRANGER_PERSON_ID)
      .map(personResource)
      .filter((p) => !q || personMatchesQuery(p, q));
    const rows = matching.filter((p) => !level || personMatchesLevel(p, level)).sort(comparePeople);
    return HttpResponse.json({ people: rows, counts: countPeople(matching) } satisfies PeopleList);
  }),

  // Every account ever observed — from links, the sentinel log, and channel
  // mirrors — with its derived state. `?state=unlinked` is the discovery queue:
  // every account nobody has placed, which is the question the retired unknown
  // senders endpoint answered over one channel at a time.
  //
  // The contacts list: every account, by name, carrying nothing about what
  // anyone said. `/api/accounts/stream` below is the other half.
  http.get("/api/accounts", ({ request }) => {
    const params = new URL(request.url).searchParams;
    const state = readState(params);
    if ("error" in state) return state.error;
    const rawCursor = params.get("cursor");
    const cursor = parseAccountCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return HttpResponse.json({ error: "cursor is not an account cursor" }, { status: 400 });
    }

    // Paging, counts and ordering are the shared rule's job, so the fixtures
    // cannot drift from the route on any of them.
    return HttpResponse.json(
      sliceAccountDirectory(observedAccounts().map(directoryRow), {
        query: params.get("q"),
        state: state.state,
        cursor,
        limit: params.get("limit") ? Number(params.get("limit")) : null,
      }),
    );
  }),

  // The recents surface: the accounts something has happened on, newest first.
  http.get("/api/accounts/stream", ({ request }) => {
    const params = new URL(request.url).searchParams;
    const state = readState(params);
    if ("error" in state) return state.error;
    const rawCursor = params.get("cursor");
    const cursor = parseStreamCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return HttpResponse.json({ error: "cursor is not a stream cursor" }, { status: 400 });
    }

    return HttpResponse.json(
      sliceAccountStream(
        observedAccounts().flatMap((ref) => streamRow(ref) ?? []),
        {
          query: params.get("q"),
          state: state.state,
          cursor,
          limit: params.get("limit") ? Number(params.get("limit")) : null,
        },
      ),
    );
  }),

  // Dismiss: deliberately attribute the account to no one the guardian tracks.
  // Refuses over a linked account — unlink is the verb for that. Idempotent.
  http.post("/api/accounts/:channel/:channelUserId/dismiss", ({ params }) => {
    const ref = refFromParams(params);
    const owner = ownerOf(ref.channel, ref.channelUserId);
    if (owner && owner.id !== STRANGER_PERSON_ID) {
      return HttpResponse.json(linkConflict(ref, owner), { status: 409 });
    }
    const sentinel = strangerRow();
    if (!sentinel) return notFound("account");
    if (!owner) {
      sentinel.channelMappings.push({ channel: ref.channel, channelUserId: ref.channelUserId });
    }
    return HttpResponse.json(directoryRow(ref));
  }),

  // Restore: dismissed -> unlinked, back into discovery. Idempotent from
  // unlinked. Refuses over a linked account for the same reason dismiss does.
  http.post("/api/accounts/:channel/:channelUserId/restore", ({ params }) => {
    const ref = refFromParams(params);
    const owner = ownerOf(ref.channel, ref.channelUserId);
    if (owner && owner.id !== STRANGER_PERSON_ID) {
      return HttpResponse.json(linkConflict(ref, owner), { status: 409 });
    }
    if (owner) {
      owner.channelMappings = owner.channelMappings.filter(
        (m) => !(m.channel === ref.channel && m.channelUserId === ref.channelUserId),
      );
    }
    return HttpResponse.json(directoryRow(ref));
  }),

  http.post("/api/people", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as Partial<CreatePersonRequest>;
    if (!body.displayName) {
      return HttpResponse.json({ error: "displayName is required" }, { status: 400 });
    }
    const bondLevel = body.bondLevel ?? "other";
    if (!isAssignableBondLevel(bondLevel)) {
      return HttpResponse.json(
        { error: "bondLevel must be inner-circle, acquaintance, or other" },
        { status: 400 },
      );
    }
    const accounts = body.accounts ?? [];
    // Atomic create-and-link: refuse the whole request before creating anything
    // if any named account is held by a real person — never a half-made person.
    for (const ref of accounts) {
      const owner = ownerOf(ref.channel, ref.channelUserId);
      if (owner && owner.id !== STRANGER_PERSON_ID) {
        return HttpResponse.json(linkConflict(ref, owner), { status: 409 });
      }
    }
    const created: PersonFixture = {
      id: nextPersonId(body.displayName),
      displayName: body.displayName,
      bondLevel,
      channelMappings: [],
    };
    persons.push(created);
    for (const ref of accounts) link(created, ref, undefined);
    return HttpResponse.json(personResource(created), { status: 201 });
  }),

  http.get("/api/people/:id/messages", ({ params, request }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    const search = new URL(request.url).searchParams;
    const channel = search.get("channel");
    const all = (personTimeline(person.id) ?? []).filter(
      (entry) => !channel || entry.source === channel,
    );
    const rawCursor = search.get("cursor");
    const cursor = parseTimelineCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return HttpResponse.json({ error: "cursor is not a timeline cursor" }, { status: 400 });
    }
    const limit = timelinePageLimit(search.get("limit"));
    const remaining: TimelineEntry[] = cursor
      ? all.filter((entry) => isAfterTimelineCursor(entry, cursor))
      : all;
    const page = remaining.slice(0, limit);
    const oldest = page.at(-1);
    return HttpResponse.json({
      entries: page,
      nextCursor: remaining.length > page.length && oldest ? timelineCursor(oldest) : null,
    } satisfies TimelinePage);
  }),

  /**
   * Say something to one of this person's accounts.
   *
   * 202 rather than 200, and an outbox row rather than a timeline entry: the
   * channel taking a message is not the message arriving, and the body says
   * which of those has happened.
   */
  http.post("/api/people/:id/messages", async ({ params, request }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");

    const parsed = parseSendMessageRequest(await request.json().catch(() => null));
    if ("error" in parsed) return HttpResponse.json({ error: parsed.error }, { status: 400 });

    // The account has to be one of theirs. A request naming somebody else's
    // address is not one this person's page can answer, and sending anyway
    // would deliver a message the guardian addressed to someone else.
    const held = person.channelMappings.some(
      (m) =>
        m.channel === parsed.request.channel && m.channelUserId === parsed.request.channelUserId,
    );
    if (!held) {
      return HttpResponse.json(
        { error: "That account is not linked to this person" },
        { status: 400 },
      );
    }

    // The same state the person read answered with, so a client that raced a
    // disconnect renders the reason it would already have shown.
    const send = sendState(parsed.request.channel);
    if (send !== "yes") {
      return HttpResponse.json({ error: refusalMessage(send), send } satisfies SendRefusal, {
        status: 409,
      });
    }

    return HttpResponse.json(outboxMessage(openRow(parsed.request, parsed.request.text)), {
      status: 202,
    });
  }),

  /** Every send of this person's still in flight. Unpaged — an outbox long
   *  enough to page is an incident rather than a listing. */
  http.get("/api/people/:id/outbox", ({ params }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    return HttpResponse.json({ messages: readOutbox(person) } satisfies OutboxPage);
  }),

  /** Try a failed send again. Under its own id, so a retry never reads as a
   *  second message the guardian did not write. */
  http.post("/api/people/:id/outbox/:messageId/retry", ({ params }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    // The row is claimed by the state it is in: a second retry of one already
    // reopened finds nothing, which is what stops a double-clicked Retry
    // delivering the guardian's message twice.
    // Retry accepts a failed row and nothing else, and the state is what claims
    // it: the second of two retries finds a row that is no longer theirs to
    // send.
    const row = rowOf(person, String(params.messageId));
    if (!row || row.state !== "failed") return notTheirs();
    row.state = "sending";
    row.error = null;
    row.ref = null;
    row.attempts += 1;
    row.attemptedAt = Date.now();
    return HttpResponse.json(outboxMessage(row), { status: 202 });
  }),

  /** Give up on a failed send. The only way a row leaves the outbox without
   *  having been delivered. */
  http.delete("/api/people/:id/outbox/:messageId", ({ params }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    const row = rowOf(person, String(params.messageId));
    if (!row || !isDismissableRow(row, Date.now())) return notTheirs();
    outbox.splice(outbox.indexOf(row), 1);
    return new HttpResponse(null, { status: 204 });
  }),

  http.get("/api/people/:id", ({ params }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    return HttpResponse.json(personResource(person));
  }),

  http.patch("/api/people/:id", async ({ params, request }) => {
    const parsed = parseUpdatePersonRequest(await request.json().catch(() => null));
    if ("error" in parsed) return HttpResponse.json({ error: parsed.error }, { status: 400 });
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    // The guardian's name is theirs to change like anyone's; the tier under
    // them is the top of the ladder and stays where it is.
    if (parsed.update.bondLevel !== undefined && protectedPersonReason(person) === "guardian") {
      return HttpResponse.json(
        { error: "the guardian's bond level cannot be changed" },
        { status: 400 },
      );
    }
    Object.assign(person, parsed.update);
    return HttpResponse.json(personResource(person));
  }),

  http.post("/api/people/:id/accounts", async ({ params, request }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    const body = (await request.json().catch(() => ({}))) as Partial<LinkAccountRequest>;
    if (!body.channel || !body.channelUserId) {
      return HttpResponse.json(
        { error: "channel and channelUserId are required" },
        { status: 400 },
      );
    }
    const result = link(
      person,
      { channel: body.channel, channelUserId: body.channelUserId },
      body.transferFrom,
    );
    if ("status" in result) return HttpResponse.json(result.body, { status: result.status });
    return HttpResponse.json(personResource(person));
  }),

  http.delete("/api/people/:id/accounts/:channel/:channelUserId", ({ params }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    const ref = refFromParams(params);
    const held = person.channelMappings.some(
      (m) => m.channel === ref.channel && m.channelUserId === ref.channelUserId,
    );
    if (!held) {
      return HttpResponse.json({ error: "account is not linked to this person" }, { status: 404 });
    }
    person.channelMappings = person.channelMappings.filter(
      (m) => !(m.channel === ref.channel && m.channelUserId === ref.channelUserId),
    );
    return HttpResponse.json(personResource(person));
  }),

  // Merge: :id absorbs `from` — every link transfers, then `from` is deleted.
  // First-class rather than N transfers + a delete, for the same reason
  // transfer itself is explicit: history re-attribution should be atomic.
  http.post("/api/people/:id/merge", async ({ params, request }) => {
    const into = String(params.id);
    const parsed = parseMergeRequest(await request.json().catch(() => null), into);
    if ("error" in parsed) return HttpResponse.json({ error: parsed.error }, { status: 400 });
    const target = findVisiblePerson(into);
    if (!target) return notFound("person");
    const source = findVisiblePerson(parsed.merge.from);
    if (!source) return notFound("person");
    if (protectedPersonReason(source) === "guardian") {
      return HttpResponse.json({ error: "the guardian cannot be merged away" }, { status: 400 });
    }
    target.channelMappings.push(...source.channelMappings);
    persons.splice(persons.indexOf(source), 1);
    return HttpResponse.json(personResource(target));
  }),
];
