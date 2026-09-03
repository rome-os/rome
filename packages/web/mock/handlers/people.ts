import { http, HttpResponse } from "msw";
import { talkConnections } from "./connections-store";
import {
  generatePersonSlug,
  nextAvailablePersonId,
  STRANGER_PERSON_DISPLAY_NAME,
  STRANGER_PERSON_ID,
} from "@rome/api-types/persons";
import {
  compareTimelineEntries,
  whatsAppDisplayName,
  type TimelineEntry,
} from "@rome/api-types/people";

/**
 * The People tab's in-memory store: the curated people, the sentinel log, and
 * the channel mirrors behind them — plus the per-channel message and send
 * endpoints served straight off it.
 *
 * The store is exported because the /people contract (./people-api.ts) is
 * served from it too: one store, so a link made through the contract is visible
 * to the thread a mirror endpoint opens, and a send lands where the next read
 * of either surface will find it.
 */

// The WhatsApp mirror's own shapes, which are on neither noun of the /people
// contract: a thread is a conversation rather than an account, so nothing here
// reaches a /accounts row.
//
// They live in this file because this file is their only reader. The dashboard
// reads the channel-blind contract instead, and core still serves
// `/api/whatsapp/contacts*` for callers outside it — so the mock keeps standing
// in for routes that exist, and nothing else needs the definitions to do it.

/** One row of `/api/whatsapp/contacts/:jid/messages`. */
interface WhatsAppMessage {
  id: string;
  senderJid: string | null;
  senderName: string | null;
  senderPhoneNumber: string | null;
  fromMe: boolean;
  /** Unix seconds. */
  timestamp: number;
  type: string | null;
  text: string | null;
  hasMedia: boolean;
  pushName: string | null;
  reactsToId: string | null;
}

/** One row of `/api/whatsapp/contacts`. */
interface WhatsAppContact {
  jid: string;
  phoneNumber: string | null;
  name: string | null;
  notify: string | null;
  verifiedName: string | null;
  imgUrl: string | null;
  chatName: string | null;
  isGroup: boolean;
  linkedPersonId: string | null;
  linkedPersonName: string | null;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  messageCount: number;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Fixture clock, in epoch **seconds** — the unit both `sentinel_log.created_at`
 * (a drizzle `mode: "timestamp"` column) and `wa_messages.timestamp` are stored
 * in, and the unit every reader on this page multiplies back up by 1000.
 *
 * Relative, because the page computes each "8m ago", day separator and clock
 * time against the browser's real clock. Literal dates would decay into a
 * thread whose every message reads as months old and whose separators all
 * collapse onto one day.
 */
const secondsAgo = (offset: number): number => Math.floor(Date.now() / 1000) - offset;

/** Local midnight this morning, in epoch seconds. */
const startOfToday = (): number => {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return Math.floor(midnight.getTime() / 1000);
};

/**
 * A time on yesterday's local calendar day.
 *
 * The Today/Yesterday separator is a calendar comparison, not an elapsed-time
 * one, so a relative offset cannot express "yesterday": `secondsAgo(DAY + 5h)`
 * is 29 hours back, which lands two calendar days ago whenever the page is
 * opened before 05:00. Anchoring to midnight makes the branch hold at every
 * hour rather than most of them.
 */
const yesterdayAt = (hour: number, minute = 0): number =>
  startOfToday() - DAY + hour * HOUR + minute * MINUTE;

/**
 * `offset` seconds ago, but never earlier than this morning.
 *
 * The clamp is what keeps the other side of the separator honest just after
 * midnight, when "40 minutes ago" would otherwise still be yesterday and the
 * thread would render one group and no separator at all.
 */
const todayAt = (offset: number): number => Math.max(secondsAgo(offset), startOfToday() + MINUTE);

const RAY_JID = "14155550142@s.whatsapp.net";
const MIRA_JID = "14155550188@s.whatsapp.net";
const DEV_JID = "447700900812@s.whatsapp.net";
const PHONE_ONLY_JID = "14085551190@s.whatsapp.net";
const CLINIC_JID = "12065550117@s.whatsapp.net";
const QUIET_JID = "6598023311@s.whatsapp.net";
const QUIET_CJK_JID = "8613800138000@s.whatsapp.net";
const HIKES_JID = "120363041948572901@g.us";

/** Devika is the one person three surfaces describe at once — the unmapped
 *  queue, the contact card and the thread — because she is an unmapped sender on
 *  a synced channel. Production feeds all three from one message and one push
 *  name, so they read them from here. Her contact row needs no entry of its own:
 *  it projects off the thread. */
// LinkedIn addresses a member by its bare member id, which is the
// `channelUserId` an inbound LinkedIn message resolves through.
const LI_ARVIND_MEMBER = "ACoAAArvind01";
const LI_CALEB_MEMBER = "ACoAACaleb02";

const DEVIKA_NAME = "Devika";
const DEVIKA_LATEST = { text: "Are you going on Saturday?", at: 3 * HOUR };

/** The curated graph's row, as the `persons` table holds it: the stored bond
 *  level, free text included, and the accounts linked to it. `./people-api.ts`
 *  projects it into `PersonResource`, so a fixture that drops a field breaks
 *  the surface that reads it. */
interface PersonFixture {
  id: string;
  displayName: string;
  bondLevel: string;
  channelMappings: { channel: string; channelUserId: string }[];
}

/**
 * What a contact row actually stores: address-book facts, and nothing derived.
 *
 * The five omitted fields are all projections on the real API — the pair
 * naming the account is a join onto `channel_mappings`, and the summary trio is a subquery
 * over `wa_messages`. Storing any of them here would let a link or a send leave
 * the card disagreeing with the thread behind it, which is the one thing these
 * fixtures exist to keep honest.
 */
type WhatsAppContactRow = Omit<
  WhatsAppContact,
  "linkedPersonId" | "linkedPersonName" | "lastMessageAt" | "lastMessagePreview" | "messageCount"
>;

// The curated graph. Bond levels are chosen to cover each branch the page
// takes on them rather than to look like a plausible address book.
export const persons: PersonFixture[] = [
  {
    // The guardian. `/api/bootstrap` reports `phase: "ready"`, and the only
    // route to that phase inserts this row, so a persons payload without it is
    // a state the instance cannot be in. It is also the only fixture that
    // reaches the guardian bond styling and the mention list's guardian
    // exclusion. Id and name track the `/api/auth/me` fixture, since onboarding
    // slugs the id from the name it was given.
    id: "mock-guardian",
    displayName: "Mock Guardian",
    bondLevel: "guardian",
    channelMappings: [],
  },
  {
    id: "ray-oster",
    displayName: "Ray Oster",
    bondLevel: "inner-circle",
    // Two channels, one of them WhatsApp: the card's WhatsApp pill is a button
    // that opens the thread, so this is the only person row that reaches the
    // messages dialog from the known-people section.
    channelMappings: [
      { channel: "telegram", channelUserId: "418820113" },
      { channel: "whatsapp", channelUserId: RAY_JID },
    ],
  },
  {
    id: "mira-chen",
    displayName: "Mira Chen",
    bondLevel: "acquaintance",
    channelMappings: [{ channel: "whatsapp", channelUserId: MIRA_JID }],
  },
  {
    // Reachable on LinkedIn and nowhere else. LinkedIn used to be a section of
    // its own below this page, on its own endpoints, because a thread resolved
    // to no person; it resolves now, so this row is how the channel appears —
    // a contact in the directory with a history on their own page, the same as
    // a WhatsApp-only contact.
    id: "arvind-srivastav",
    displayName: "Arvind Srivastav",
    bondLevel: "acquaintance",
    channelMappings: [{ channel: "linkedin", channelUserId: LI_ARVIND_MEMBER }],
  },
  {
    id: "hollis-park",
    displayName: "Hollis Park",
    bondLevel: "other",
    channelMappings: [{ channel: "discord", channelUserId: "284417003118395393" }],
  },
  {
    // A bond level outside the three the create form offers. The column is free
    // text and older rows carry values like this one, so the page has to bucket
    // it under "other" and fall back to that styling rather than render a blank
    // pill and drop the row from every filter.
    id: "sam-okafor",
    displayName: "Sam Okafor",
    bondLevel: "colleague",
    channelMappings: [{ channel: "webchat", channelUserId: "wc-8842" }],
  },
  {
    // Created by hand and never linked to a channel — the card's "no channels"
    // line, which is otherwise unreachable once every person arrives through a
    // sender promotion.
    id: "nadia-petrova",
    displayName: "Nadia Petrova",
    bondLevel: "inner-circle",
    channelMappings: [],
  },
  {
    // The sentinel row core seeds at boot, carrying one already-dismissed
    // sender. `/api/people` withholds it and `/api/accounts` surfaces its
    // holdings as dismissed rows — it is here to keep those honest, not to be
    // looked at.
    id: STRANGER_PERSON_ID,
    displayName: STRANGER_PERSON_DISPLAY_NAME,
    bondLevel: "other",
    channelMappings: [{ channel: "telegram", channelUserId: "770144238" }],
  },
];

// Senders seen in `sentinel_log`. `?state=unlinked` on the account directory
// is the half of these with no row in `channel_mappings`, so this list is the
// raw log and the join runs in the handler — that is what makes a link take a
// row out of the discovery queue instead of leaving it there until a reload.
/** A `sentinel_log` row, plus what Rome said back when it replied — the table
 *  records both halves of an exchange, and the timeline renders both. */
type SentinelRow = {
  channel: string;
  channelUserId: string;
  displayName: string | null;
  lastMessage: string | null;
  /** Unix seconds. */
  lastMessageAt: number | null;
  reply?: string;
  /** This log row's own id. A timeline `ref` has to be unique across
   *  everything one source contributes to a person, and one account can hold
   *  several log rows, so the refs key on this rather than on the account those
   *  rows share. */
  logId: string;
};

export const sentinelSenders: SentinelRow[] = (
  [
    {
      channel: "telegram",
      channelUserId: "883104221",
      displayName: "Jules Marchetti",
      lastMessage: "hey — is this the right number for the Thursday thing?",
      lastMessageAt: secondsAgo(8 * MINUTE),
      // The one row Rome answered: the dossier shows an exchange rather than
      // half of one, which is the only place an outbound sentinel entry renders.
      reply: "It is — Thursday at 6 still works.",
    },
    {
      // The WhatsApp half of the queue, and the one row another surface can
      // contradict: this is the same message the mirror holds, recorded by the
      // sentinel as it arrived. An unmapped sender on a synced channel shows up
      // in both sections, so both read it from one place.
      channel: "whatsapp",
      channelUserId: DEV_JID,
      displayName: DEVIKA_NAME,
      lastMessage: DEVIKA_LATEST.text,
      lastMessageAt: secondsAgo(DEVIKA_LATEST.at),
    },
    {
      // Neither a name nor text: the sentinel logged an inbound the channel gave
      // nothing else for. The card falls back to "Unknown sender" and drops its
      // quote entirely. On a channel with no mirror behind it on purpose — this
      // is the one row nothing else can be asked to agree with.
      channel: "telegram",
      channelUserId: "5514420983",
      displayName: null,
      lastMessage: null,
      lastMessageAt: secondsAgo(6 * HOUR),
    },
    {
      channel: "discord",
      channelUserId: "612884320117522433",
      displayName: "kev_4410",
      lastMessage: "saw your post about the rome setup, mind if I ask a couple questions?",
      lastMessageAt: secondsAgo(2 * DAY),
    },
    {
      // The placed half of LinkedIn: this sender is mapped onto a person, so it
      // never reaches the discovery queue and its exchange is what that person's
      // page shows.
      channel: "linkedin",
      channelUserId: LI_ARVIND_MEMBER,
      displayName: "Arvind Srivastav",
      lastMessage: "Great meeting you at the robotics meetup — would love to compare notes.",
      lastMessageAt: secondsAgo(4 * HOUR),
      reply: "Likewise! Free Thursday afternoon?",
    },
    {
      // The unplaced half: a LinkedIn sender waiting on a decision, sitting in
      // the same queue behind the same Unknown chip as every other channel's.
      channel: "linkedin",
      channelUserId: LI_CALEB_MEMBER,
      displayName: "Caleb Cater",
      lastMessage: "Added comments on the deck — see section 3.",
      lastMessageAt: secondsAgo(2 * HOUR),
    },
    {
      // A channel the page has no pill styling for. It renders the raw channel
      // name in the fallback pill, which is the branch every channel added after
      // the page was written lands in.
      channel: "feishu",
      channelUserId: "ou_9f21c04ab7",
      displayName: "林晓",
      lastMessage: "会议纪要已经发到群里了",
      lastMessageAt: secondsAgo(5 * DAY),
    },
    {
      // A second log row for 林晓, newer than the one above. The log keys on the
      // exchange rather than the sender, so one account can hold several — and
      // a reader that takes the first would preview an older line than the one
      // sitting at the top of this account's own timeline.
      channel: "feishu",
      channelUserId: "ou_9f21c04ab7",
      displayName: "林晓",
      lastMessage: "另外周五的场地换到 3 楼了",
      lastMessageAt: secondsAgo(2 * DAY),
    },
    {
      // A WhatsApp arrival the sentinel logged before the mirror synced the
      // chat: no contact row, no thread. The only fixture where the sentinel is
      // the sole record of a WhatsApp exchange, which is what keeps the
      // mirror-first branch from dropping it.
      channel: "whatsapp",
      channelUserId: "5511987654321@s.whatsapp.net",
      displayName: null,
      lastMessage: "oi, tudo bem? vi seu contato no grupo",
      lastMessageAt: secondsAgo(21 * MINUTE),
    },
    {
      // Already marked a stranger. Present in the log, absent from the queue —
      // the join is what hides it, and a mark-stranger write is what put it here.
      channel: "telegram",
      channelUserId: "770144238",
      displayName: null,
      lastMessage: "CLAIM YOUR PRIZE >>",
      lastMessageAt: secondsAgo(9 * DAY),
    },
  ] as Omit<SentinelRow, "logId">[]
).map((row, index) => ({ ...row, logId: `log-${index}` }));

// The WhatsApp address book. Unordered: the handler sorts, because the order
// the repository returns depends on the summary fields it projects.
export const whatsappContacts: WhatsAppContactRow[] = [
  {
    jid: RAY_JID,
    phoneNumber: "14155550142",
    name: "Ray Oster",
    notify: "Ray",
    verifiedName: null,
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
  {
    // Named only by `notify` — the push name WhatsApp attaches to a message
    // from someone who isn't in the address book. Same person as the unmapped
    // WhatsApp sender above, which is how the two sections agree: an unknown
    // sender on a synced channel shows up in both.
    jid: DEV_JID,
    phoneNumber: "447700900812",
    name: null,
    notify: DEVIKA_NAME,
    verifiedName: null,
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
  {
    // A group: no contact row behind it, so the name comes off the chat and the
    // subtitle says so rather than showing a phone number the jid doesn't have.
    jid: HIKES_JID,
    phoneNumber: null,
    name: null,
    notify: null,
    verifiedName: null,
    imgUrl: null,
    chatName: "Sunday hikes",
    isGroup: true,
  },
  {
    jid: MIRA_JID,
    phoneNumber: "14155550188",
    name: "Mira Chen",
    notify: null,
    verifiedName: null,
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
  {
    // Nothing but a number. Every name field is empty, so the card falls all
    // the way through to the formatted phone — and so does its thread's one
    // bubble, which is the only sender here the address book cannot name.
    jid: PHONE_ONLY_JID,
    phoneNumber: "14085551190",
    name: null,
    notify: null,
    verifiedName: null,
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
  {
    // Two contacts nobody has ever said anything to, and nobody has ever heard
    // from: the address book's quiet thousands, in miniature. They stay out of
    // the stream, which carries only the accounts something has happened on,
    // and the contacts list holds them like any other account.
    jid: QUIET_JID,
    phoneNumber: "6598023311",
    name: "Jonas Tan",
    notify: null,
    verifiedName: null,
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
  {
    jid: QUIET_CJK_JID,
    phoneNumber: "8613800138000",
    name: "李阿姨 Li Ayi",
    notify: null,
    verifiedName: null,
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
  {
    // A business, synced from the address book but never messaged: no time
    // label, no preview, and an empty thread behind the messages button.
    jid: CLINIC_JID,
    phoneNumber: "12065550117",
    name: null,
    notify: null,
    verifiedName: "Foothill Dental",
    imgUrl: null,
    chatName: null,
    isGroup: false,
  },
];

const guardianText = (id: string, text: string, timestamp: number): WhatsAppMessage => ({
  id,
  senderJid: null,
  senderName: null,
  senderPhoneNumber: null,
  fromMe: true,
  timestamp,
  type: "text",
  text,
  hasMedia: false,
  pushName: null,
  reactsToId: null,
});

/** `text` is null for a media message: WhatsApp sends the caption there, and an
 *  uncaptioned photo has none. */
const theirText = (
  id: string,
  contact: { jid: string; name: string | null; phone: string | null },
  text: string | null,
  timestamp: number,
  extra: Partial<WhatsAppMessage> = {},
): WhatsAppMessage => ({
  id,
  senderJid: contact.jid,
  senderName: contact.name,
  senderPhoneNumber: contact.phone,
  fromMe: false,
  timestamp,
  type: "text",
  text,
  hasMedia: false,
  pushName: contact.name,
  reactsToId: null,
  ...extra,
});

const RAY = { jid: RAY_JID, name: "Ray Oster", phone: "14155550142" };
const MIRA = { jid: MIRA_JID, name: "Mira Chen", phone: "14155550188" };
const DEVIKA = { jid: DEV_JID, name: DEVIKA_NAME, phone: "447700900812" };
/** The unsaved number. `senderName` is a coalesce over the sender's `wa_contacts`
 *  row, and this jid's row has every name field empty, so the real query returns
 *  null here — a labelled sender would be a row the API cannot produce. The
 *  thread's bubbles fall back to the formatted phone, same as its card. */
const UNSAVED = { jid: PHONE_ONLY_JID, name: null, phone: "14085551190" };

// Threads, oldest first — the order the route hands back after its own reverse.
// Ray's runs across two days and carries a reaction and an attachment, so the
// dialog's date separators, reaction badges and media placeholder all render
// off real data instead of only in a screenshot somewhere.
const threads: Record<string, WhatsAppMessage[]> = {
  [RAY_JID]: [
    theirText("wa-ray-1", RAY, "did the sensor box ever turn up?", yesterdayAt(11, 20)),
    guardianText(
      "wa-ray-2",
      "yesterday, yeah. one of the cables was missing though",
      yesterdayAt(12, 20),
    ),
    theirText("wa-ray-3", RAY, "ugh. I have a spare, I'll bring it", yesterdayAt(12, 32)),
    theirText("wa-ray-4", RAY, null, yesterdayAt(13, 20), {
      type: "image",
      hasMedia: true,
    }),
    guardianText("wa-ray-5", "that's the one 🙏", yesterdayAt(13, 24)),
    theirText("wa-ray-6", RAY, "👍", yesterdayAt(13, 25), {
      type: "reaction",
      reactsToId: "wa-ray-5",
    }),
    guardianText("wa-ray-7", "still ok for thursday at 6?", todayAt(40 * MINUTE)),
    theirText("wa-ray-8", RAY, "yep, I'll come straight from the shop", todayAt(25 * MINUTE)),
    guardianText("wa-ray-9", "perfect, see you then", todayAt(22 * MINUTE)),
  ],
  [DEV_JID]: [
    theirText(
      "wa-dev-1",
      DEVIKA,
      "Hi! Got your number from the climbing group 👋",
      secondsAgo(DEVIKA_LATEST.at + 40),
    ),
    theirText("wa-dev-2", DEVIKA, DEVIKA_LATEST.text, secondsAgo(DEVIKA_LATEST.at)),
  ],
  // A group thread: consecutive messages from different people, which is the
  // only case where the dialog labels a bubble with its sender.
  [HIKES_JID]: [
    theirText("wa-hike-1", MIRA, "weather looks fine for sunday", secondsAgo(6 * HOUR)),
    theirText("wa-hike-2", RAY, "I can drive, 3 spare seats", secondsAgo(6 * HOUR - 8 * MINUTE)),
    guardianText("wa-hike-3", "put me down for one", secondsAgo(6 * HOUR - 20 * MINUTE)),
    theirText("wa-hike-4", MIRA, "same!", secondsAgo(6 * HOUR - 24 * MINUTE)),
  ],
  [MIRA_JID]: [
    guardianText("wa-mira-1", "sent you the notes from friday", secondsAgo(2 * DAY + HOUR)),
    theirText("wa-mira-2", MIRA, "thanks for sending that over", secondsAgo(2 * DAY)),
  ],
  [PHONE_ONLY_JID]: [
    theirText(
      "wa-unsaved-1",
      UNSAVED,
      "Your appointment is confirmed for Tuesday at 10:15.",
      secondsAgo(11 * DAY),
    ),
  ],
  // CLINIC_JID has no entry on purpose: a contact synced from the address book
  // with nothing ever said. The dialog's empty thread, not a load failure.
};

/** The repository's tiebreaker for two contacts with the same last-message
 *  time: the first name field that has anything in it, lower-cased. Distinct
 *  from the page's own display choice, which is a rendering decision made
 *  against the same fields. */
function displayNameOf(contact: WhatsAppContactRow): string {
  return (
    contact.name ??
    contact.notify ??
    contact.verifiedName ??
    contact.chatName ??
    contact.phoneNumber ??
    contact.jid
  ).toLowerCase();
}

/**
 * A contact's summary trio, projected from its thread the way the repository's
 * subqueries do.
 *
 * Reactions are emoji pinned to another message rather than a line of their
 * own, so they are excluded from the preview and its timestamp — but not from
 * `messageCount`, which the repository takes as a plain `COUNT(*)` over the
 * chat.
 */
export function summarize(
  jid: string,
): Pick<WhatsAppContact, "lastMessageAt" | "lastMessagePreview" | "messageCount"> {
  const thread = threads[jid] ?? [];
  // `>`, not `>=`: the repository orders by `timestamp DESC, rowid DESC`, so
  // the last row inserted wins a tie. Threads here are append-ordered, which
  // makes the later element the higher rowid. Reachable rather than
  // theoretical — sends stamp whole seconds, so two in the same second tie.
  const newest = thread
    .filter((message) => message.type !== "reaction")
    .reduce<WhatsAppMessage | null>(
      (latest, message) => (latest && latest.timestamp > message.timestamp ? latest : message),
      null,
    );
  return {
    lastMessageAt: newest?.timestamp ?? null,
    lastMessagePreview: newest?.text ?? null,
    messageCount: thread.length,
  };
}

/** The person an account currently maps to, or `undefined` while it is
 *  still unmapped. The `channel_mappings` lookup both the unknown-sender query
 *  and the contacts join run. */
export function ownerOf(channel: string, channelUserId: string): PersonFixture | undefined {
  return persons.find((person) =>
    person.channelMappings.some(
      (mapping) => mapping.channel === channel && mapping.channelUserId === channelUserId,
    ),
  );
}

/**
 * The id `POST /api/people` mints, over the in-memory store. Both the slug
 * and the collision rule come from the shared derivation; all this adds is the
 * set of ids to resolve against, which is the one thing the two sides cannot
 * share — the repository resolves against the rows it queries, this against the
 * rows it holds.
 *
 * A name that slugs to nothing gets a uuid on the real route.
 * `crypto.randomUUID` is the browser's equivalent of core's `uuid()`.
 */
export function nextPersonId(displayName: string): string {
  const base = generatePersonSlug(displayName);
  if (!base) return crypto.randomUUID();
  return nextAvailablePersonId(
    base,
    persons.map((person) => person.id),
  );
}

/** What the account's own platform calls it, then the name its sender put on a
 *  message, then the address itself — the order `DirectoryAccount.displayName`
 *  and `LinkedAccount.displayName` both name. Never the linked person's name. */
export function nameForAccount(channel: string, channelUserId: string): string {
  const contact =
    channel === "whatsapp"
      ? whatsappContacts.find((candidate) => candidate.jid === channelUserId)
      : undefined;
  const sender = sentinelSenders.find(
    (s) => s.channel === channel && s.channelUserId === channelUserId,
  );
  return (contact ? whatsAppDisplayName(contact) : null) ?? sender?.displayName ?? channelUserId;
}

/** One account, named the way every channel names it: the platform and its own
 *  id for the person there. */
export interface AccountRef {
  channel: string;
  channelUserId: string;
}

/**
 * One person's dynamics, newest first, the way the route merges them: the
 * WhatsApp mirror holds full threads, and every other channel contributes the
 * single line the sentinel recorded. Entries are generic — source, time, body,
 * direction, ref — so nothing here knows it is looking at WhatsApp.
 */
export function personTimeline(personId: string): TimelineEntry[] | null {
  const channels = persons.find((person) => person.id === personId)?.channelMappings;
  return channels ? timelineForChannels(channels) : null;
}

/** One account's dynamics, newest first. Always an answer: an account Rome has
 *  never heard from has an empty history, not a missing one. */
export function accountTimeline(ref: AccountRef): TimelineEntry[] {
  return timelineForChannels([ref]);
}

/**
 * What Rome has said through the send route and the channel has since surfaced.
 *
 * The mock's stand-in for the store a real channel's mirror would put a
 * delivered message into. It is a store of its own rather than a flag on an
 * outbox row for the reason the contract gives: an outbox row is exactly a send
 * whose message is not on the timeline yet, so the outbox read has to be able
 * to look the message up here and find it — the same comparison the route runs,
 * rather than a delivery bit someone remembered to set.
 */
const deliveredEntries: (TimelineEntry & { channelUserId: string })[] = [];

/** Put a sent message where the timeline will find it. The `ref` is the one the
 *  outbox row is waiting on, which is what clears the row. */
export function recordDelivered(
  account: AccountRef,
  entry: Omit<TimelineEntry, "source" | "direction">,
): void {
  deliveredEntries.push({
    ...entry,
    source: account.channel,
    channelUserId: account.channelUserId,
    direction: "outbound",
  });
}

/** One channel set's dynamics, newest first. The row's `latest` is this
 *  sequence's head, so the two cannot disagree about what happened last. */
function timelineForChannels(channels: AccountRef[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const mapping of channels) {
    for (const sent of deliveredEntries) {
      if (sent.source !== mapping.channel || sent.channelUserId !== mapping.channelUserId) continue;
      const { channelUserId: _address, ...entry } = sent;
      entries.push(entry);
    }
    if (mapping.channel === "whatsapp") {
      const jid = mapping.channelUserId;
      const mirrored = threads[jid] ?? [];
      // The sentinel recorded the same arrival the mirror holds, so the two are
      // alternatives rather than additions. With no mirrored thread the
      // sentinel is all there is, and skipping it leaves an account that has
      // plainly messaged with an empty timeline, a null `latest`, and no place
      // in the Unknown count.
      if (mirrored.length === 0) {
        entries.push(...sentinelEntriesFor(mapping));
        continue;
      }
      for (const message of mirrored) {
        // A reaction is not its own dynamic — `summarize` skips them when it
        // picks `latest`, so carrying them here would let one account report
        // two different newest things. Whether the page renders them against
        // the line they answer is the page rebuild's call.
        if (message.type === "reaction") continue;
        entries.push({
          source: "whatsapp",
          timestamp: message.timestamp,
          body: message.text,
          direction: message.fromMe ? "outbound" : "inbound",
          // A WhatsApp message id is unique within its chat, and a person can
          // hold several WhatsApp accounts, so the chat qualifies it into
          // the source-global ref the contract asks for.
          ref: `${jid}:${message.id}`,
        });
      }
      continue;
    }
    entries.push(...sentinelEntriesFor(mapping));
  }
  return entries.sort(compareTimelineEntries);
}

/** Every sentinel log row for one account, as timeline entries. */
function sentinelEntriesFor(mapping: AccountRef): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const sender of sentinelSenders) {
    if (sender.channel !== mapping.channel || sender.channelUserId !== mapping.channelUserId) {
      continue;
    }
    entries.push({
      source: sender.channel,
      timestamp: sender.lastMessageAt ?? 0,
      body: sender.lastMessage,
      direction: "inbound",
      ref: `sentinel:${sender.logId}`,
    });
    if (sender.reply) {
      entries.push({
        source: sender.channel,
        timestamp: sender.lastMessageAt ?? 0,
        body: sender.reply,
        direction: "outbound",
        ref: `sentinel:${sender.logId}:reply`,
      });
    }
  }
  return entries;
}

/** The WhatsApp mirror's message and send endpoints. Not the people contract —
 *  a thread is a conversation rather than an account — so they keep their own
 *  paths and are served straight off the store above. Nothing in the dashboard
 *  reads them; they stand in for routes core still serves to other callers. */
export const channelMirrorHandlers = [
  http.get("/api/whatsapp/contacts", () => {
    const rows = whatsappContacts.map((contact) => {
      const owner = ownerOf("whatsapp", contact.jid);
      return {
        ...contact,
        ...summarize(contact.jid),
        linkedPersonId: owner?.id ?? null,
        linkedPersonName: owner?.displayName ?? null,
      } satisfies WhatsAppContact;
    });
    // The repository's ORDER BY: threads that have said something first, newest
    // first, then the silent ones by name. Sorting here rather than in the
    // fixture is what makes a send move its contact to the top.
    rows.sort((a, b) => {
      if ((a.lastMessageAt === null) !== (b.lastMessageAt === null)) {
        return a.lastMessageAt === null ? 1 : -1;
      }
      if (a.lastMessageAt !== b.lastMessageAt) {
        return (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0);
      }
      return displayNameOf(a).localeCompare(displayNameOf(b));
    });
    return HttpResponse.json(rows);
  }),

  http.get("/api/whatsapp/contacts/:jid/messages", ({ params, request }) => {
    const thread = threads[String(params.jid)] ?? [];
    const raw = Number(new URL(request.url).searchParams.get("limit"));
    // The route reads the newest `limit` and hands them back oldest-first, so a
    // long thread opens on its tail rather than its beginning.
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 500) : 50;
    return HttpResponse.json(thread.slice(-limit));
  }),

  // The real route hands the text to the adapter and persists nothing; Baileys
  // echoes it back as a `fromMe` message, which the mirror picks up and the
  // next poll shows. Appending here is that echo — without it the composer's
  // optimistic bubble would never reconcile and would sit "sending" forever.
  http.post("/api/whatsapp/contacts/:jid/send", async ({ params, request }) => {
    const jid = String(params.jid);
    const body = (await request.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return HttpResponse.json({ error: "text is required" }, { status: 400 });

    // The route sends through a live transport, so it refuses when the channel
    // has none — and the composer has its own copy for that 503. Disconnecting
    // WhatsApp on the Connections page is what makes this reachable; without
    // the check, a visibly disconnected account would keep sending.
    if (talkConnections("whatsapp").length !== 1) {
      return HttpResponse.json({ error: "WhatsApp is not connected" }, { status: 503 });
    }

    const thread = (threads[jid] ??= []);
    thread.push(guardianText(`wa-sent-${jid}-${thread.length}`, text, secondsAgo(0)));

    return HttpResponse.json({ ok: true });
  }),
];
