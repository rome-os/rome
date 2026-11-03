import { http, HttpResponse } from "msw";
import { protectedPersonReason } from "@rome/api-types/persons";
import {
  accountPresentation,
  comparePeople,
  countPeople,
  isAssignableBondLevel,
  latestDynamic,
  parseAccountCursor,
  parseAccountState,
  parseStreamCursor,
  parseMergeRequest,
  parsePersonFilterLevel,
  parseSendMessageRequest,
  parseUpdatePersonRequest,
  personMatchesLevel,
  personMatchesQuery,
  sendRefusalMessage,
  sliceAccountDirectory,
  sliceAccountStream,
  timelinePageLimit,
  type CreatePersonRequest,
  type DirectoryAccount,
  type LinkAccountRequest,
  type LinkConflict,
  type AccountSendState,
  type AccountState,
  type PeopleList,
  type PersonResource,
  type SendRefusal,
  type SentMessage,
  type StreamAccount,
  type TimelinePage,
} from "@rome/api-types/people";
import {
  isAfterMessageCursor,
  messageCursor,
  parseMessageCursor,
  type Message,
} from "@rome/api-types/message";
import { talkConnections } from "./connections-store";
import { memoryProfilePath } from "./memory-files";
import {
  LI_ARVIND_MEMBER,
  accountTimeline,
  nameForAccount,
  nextPersonId,
  ownerOf,
  dismissalOf,
  dismissedAccounts,
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
 * A dismissal is its own record (`dismissedAccounts`), presented as
 * `state: "dismissed"` through `accountPresentation`.
 */

function sendState({ channel, channelUserId }: AccountRef): AccountSendState {
  if (talkConnections(channel).length === 0) return "not-connected";
  if (channel === "linkedin") return channelUserId === LI_ARVIND_MEMBER ? "yes" : "no-conversation";
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
      send: sendState(a),
      // The account's own head, not the person's: the person's newest entry
      // names a channel and not an address, so it cannot say which of two
      // accounts on one channel was the recent one.
      latestAt: accountTimeline(a)[0]?.timestamp ?? null,
      ...(a.delegate ? { delegate: true as const } : {}),
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
    ...accountPresentation(
      owner
        ? { personId: owner.id, displayName: owner.displayName }
        : dismissalOf(ref.channel, ref.channelUserId) >= 0
          ? { dismissed: true }
          : null,
    ),
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
  for (const d of dismissedAccounts) add(d.channel, d.channelUserId);
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

const findVisiblePerson = (id: string) => persons.find((p) => p.id === id);

const notFound = (what: string) => HttpResponse.json({ error: `Unknown ${what}` }, { status: 404 });

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
  if (owner && owner.id !== transferFrom) {
    return { status: 409, body: linkConflict(ref, owner) };
  }
  if (transferFrom && owner?.id !== transferFrom) {
    return {
      status: 409,
      body: {
        error: "transferFrom does not match the account's current owner",
        linkedPersonId: owner ? owner.id : null,
      },
    };
  }
  // A transfer moves the link itself, so its delegate mark goes with it.
  const moved = owner?.channelMappings.find(
    (m) => m.channel === ref.channel && m.channelUserId === ref.channelUserId,
  );
  if (owner) {
    owner.channelMappings = owner.channelMappings.filter((m) => m !== moved);
  }
  const dismissal = dismissalOf(ref.channel, ref.channelUserId);
  if (dismissal >= 0) dismissedAccounts.splice(dismissal, 1);
  person.channelMappings.push(moved ?? { channel: ref.channel, channelUserId: ref.channelUserId });
  return { ok: true };
}

const refFromParams = (params: Record<string, unknown>): AccountRef => ({
  channel: String(params.channel),
  channelUserId: decodeURIComponent(String(params.channelUserId)),
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Sends the channel has refused once, by account and text.
 *
 * A message starting with "fail" is refused the first time it is sent, so the
 * dashboard's failed state and its Retry can both be reached: a mock has no
 * provider to be down. The retry is a new request with the same text, and it
 * goes through.
 */
const refusedOnce = new Set<string>();

function refuses(account: AccountRef, text: string): boolean {
  if (!text.toLowerCase().startsWith("fail")) return false;
  const key = `${account.channel}\u0000${account.channelUserId}\u0000${text}`;
  if (refusedOnce.has(key)) return false;
  refusedOnce.add(key);
  return true;
}

export const peopleHandlers = [
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
    const matching = persons.map(personResource).filter((p) => !q || personMatchesQuery(p, q));
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
        channel: params.get("channel"),
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
    if (owner) return HttpResponse.json(linkConflict(ref, owner), { status: 409 });
    if (dismissalOf(ref.channel, ref.channelUserId) < 0) {
      dismissedAccounts.push({ channel: ref.channel, channelUserId: ref.channelUserId });
    }
    return HttpResponse.json(directoryRow(ref));
  }),

  // Restore: dismissed -> unlinked, back into discovery. Idempotent from
  // unlinked. Refuses over a linked account for the same reason dismiss does.
  http.post("/api/accounts/:channel/:channelUserId/restore", ({ params }) => {
    const ref = refFromParams(params);
    const owner = ownerOf(ref.channel, ref.channelUserId);
    if (owner) return HttpResponse.json(linkConflict(ref, owner), { status: 409 });
    const dismissal = dismissalOf(ref.channel, ref.channelUserId);
    if (dismissal >= 0) dismissedAccounts.splice(dismissal, 1);
    return HttpResponse.json(directoryRow(ref));
  }),

  // A fixed code: mock mode links nothing, so only the dialog is exercised.
  http.post("/api/people/link-code", () =>
    HttpResponse.json({ code: "ROME-7KQ2M9XA", expiresAt: Date.now() + 600_000 }, { status: 201 }),
  ),

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
      if (owner) return HttpResponse.json(linkConflict(ref, owner), { status: 409 });
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
    const cursor = parseMessageCursor(rawCursor);
    if (rawCursor != null && rawCursor !== "" && cursor === null) {
      return HttpResponse.json({ error: "cursor is not a timeline cursor" }, { status: 400 });
    }
    const limit = timelinePageLimit(search.get("limit"));
    const remaining: Message[] = cursor
      ? all.filter((entry) => isAfterMessageCursor(entry, cursor))
      : all;
    const page = remaining.slice(0, limit);
    const oldest = page.at(-1);
    return HttpResponse.json({
      entries: page,
      nextCursor: remaining.length > page.length && oldest ? messageCursor(oldest) : null,
    } satisfies TimelinePage);
  }),

  /**
   * Say something to one of this person's accounts. One call: the channel takes
   * the message and Rome's copy is on the timeline, or the channel's refusal
   * comes back as a 502.
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
    const send = sendState(parsed.request);
    if (send !== "yes") {
      return HttpResponse.json({ error: sendRefusalMessage(send), send } satisfies SendRefusal, {
        status: 409,
      });
    }

    if (refuses(parsed.request, parsed.request.text)) {
      return HttpResponse.json({ error: "the channel rejected this message" }, { status: 502 });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const ref = `${parsed.request.channelUserId}:${crypto.randomUUID()}`;
    recordDelivered(parsed.request, { timestamp, body: parsed.request.text, ref });
    return HttpResponse.json({ ref, timestamp } satisfies SentMessage);
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

  // Delete: the person and their links go, so their accounts are strangers
  // again. The guardian stays.
  http.delete("/api/people/:id", ({ params }) => {
    const person = findVisiblePerson(String(params.id));
    if (!person) return notFound("person");
    if (protectedPersonReason(person) === "guardian") {
      return HttpResponse.json({ error: "the guardian cannot be deleted" }, { status: 400 });
    }
    persons.splice(persons.indexOf(person), 1);
    return new HttpResponse(null, { status: 204 });
  }),
];
