import { http, HttpResponse } from "msw";
import {
  accountPresentation,
  comparePeople,
  countPeople,
  parseAccountCursor,
  parseAccountState,
  parsePersonFilterLevel,
  personMatchesLevel,
  personMatchesQuery,
  sliceAccountDirectory,
  type DirectoryAccount,
  type AccountSendState,
  type AccountState,
  type PeopleList,
  type PersonResource,
} from "@rome/api-types/people";
import { talkConnections } from "./connections-store";
import { memoryProfilePath } from "./memory-files";
import {
  LI_ARVIND_MEMBER,
  accountTimeline,
  nameForAccount,
  ownerOf,
  dismissalOf,
  dismissedAccounts,
  persons,
  sentinelSenders,
  whatsappContacts,
  type AccountRef,
} from "./people";

/**
 * The people and account reads over the fixture store in ./people.ts. Wire
 * types: `@rome/api-types/people`; vocabulary: docs/concepts/people.md.
 *
 * Mock mode's implementation of the same surface core serves
 * (`packages/core/src/people/phone-book/http/people.ts` and `.../accounts.ts`), typed
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
  return {
    id: person.id,
    displayName: person.displayName,
    bondLevel: person.bondLevel,
    accounts: person.channelMappings.map((a) => ({
      channel: a.channel,
      channelUserId: a.channelUserId,
      displayName: nameForAccount(a.channel, a.channelUserId),
      send: sendState(a),
      latestAt: accountTimeline(a)[0]?.timestamp ?? null,
      ...(a.delegate ? { delegate: true as const } : {}),
    })),
    // Read off the memory tree (./memory-files.ts) rather than a list here, so
    // it names only a profile the Memory page can open. Not everyone has one,
    // because nothing writes a profile when a person is created, so the
    // fixtures hold both states.
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

/** Every account the three sources name, once each — what the account read is
 *  cut out of. */
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
  // anyone said.
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
];
