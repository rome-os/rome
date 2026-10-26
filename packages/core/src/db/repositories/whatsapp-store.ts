import { sql, type SQL } from "drizzle-orm";
import { waContacts, waChats, waMessages } from "../schema.js";
import type { DrizzleDb } from "../index.js";
import type {
  WaContactInput,
  WaChatInput,
  WaHistoryMessage,
  WaMessageInput,
  WhatsAppSyncSink,
} from "../../channels/whatsapp-sync.js";

const UPSERT_CHUNK = 200;
const HISTORY_READ_LIMIT = 1000;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Group key folding a single person's two WhatsApp addresses — their
 * phone-number JID (`<pn>@s.whatsapp.net`) and their privacy LID (`<lid>@lid`) —
 * onto one account. WhatsApp delivers a contact's conversation under the LID
 * (which Baileys annotates with the resolved phone number) while the address-book
 * name lives on the `@s.whatsapp.net` row, so one person otherwise shows up as
 * two cards: a named-but-silent one and a talking-but-nameless one. Both rows
 * carry the same phone number, so we key individuals on their digits. Groups
 * (`@g.us`) never share a phone number and key on their own JID, so they never
 * merge.
 */
function accountKey(r: WhatsAppContactAliasRow): string {
  if (!r.isGroup && r.phoneNumber) {
    const digits = r.phoneNumber.replace(/\D/g, "");
    if (digits) return `pn:${digits}`;
  }
  return `jid:${r.jid}`;
}

/** First non-empty value of `key` across the group, or null. */
function coalesceField<K extends keyof WhatsAppContactAliasRow>(
  group: WhatsAppContactAliasRow[],
  key: K,
): WhatsAppContactAliasRow[K] | null {
  for (const r of group) {
    const v = r[key];
    if (v != null && v !== "") return v;
  }
  return null;
}

/**
 * Collapse the LID and phone-number threads of one person into a single card.
 * `rows` arrives in display order (conversations first, then alphabetical), so
 * each group's first row is its best representative — we keep its JID as the
 * card's own address (the conversation-bearing one when a chat exists, so opening
 * the chat still resolves its messages) and fold the missing pieces in from its
 * siblings: the address-book name, a person link, and the richer message history.
 * Every JID that went into the group is kept in `aliases`, sorted, so a caller
 * that needs the whole address set does not have to re-derive the grouping.
 */
function consolidateByAccount(rows: WhatsAppContactAliasRow[]): WhatsAppContactRow[] {
  const groups = new Map<string, WhatsAppContactAliasRow[]>();
  for (const r of rows) {
    const k = accountKey(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }

  const merged: WhatsAppContactRow[] = [];
  for (const group of groups.values()) {
    const aliases = group.map((r) => r.jid).sort();
    if (group.length === 1) {
      merged.push({ ...group[0], aliases });
      continue;
    }
    const primary = group[0];
    const linked = group.find((r) => r.linkedPersonId != null);
    // The whole conversation usually lives on one JID, but take the latest row
    // defensively in case history is split across both addresses.
    const latest = group.reduce(
      (best, r) => ((r.lastMessageAt ?? -1) > (best.lastMessageAt ?? -1) ? r : best),
      primary,
    );
    merged.push({
      ...primary,
      phoneNumber: coalesceField(group, "phoneNumber"),
      name: coalesceField(group, "name"),
      notify: coalesceField(group, "notify"),
      verifiedName: coalesceField(group, "verifiedName"),
      imgUrl: coalesceField(group, "imgUrl"),
      chatName: coalesceField(group, "chatName"),
      linkedPersonId: linked?.linkedPersonId ?? null,
      linkedPersonName: linked?.linkedPersonName ?? null,
      lastMessageAt: latest.lastMessageAt,
      lastMessagePreview: latest.lastMessagePreview,
      messageCount: group.reduce((n, r) => n + r.messageCount, 0),
      aliases,
    });
  }
  return merged;
}

export interface WhatsAppContactRow {
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
  /** Unix seconds, or null when no message history exists for the contact. */
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  messageCount: number;
  /**
   * Every JID folded into this card, sorted — the phone-number form, the LID
   * form, or both. Always contains `jid`.
   */
  aliases: string[];
}

/** One address-book JID as the query reads it, before grouping folds aliases. */
type WhatsAppContactAliasRow = Omit<WhatsAppContactRow, "aliases">;

/**
 * Durable store for the WhatsApp address-book mirror (contacts, chats, recent
 * message history). Writes are fed by the adapter as a {@link WhatsAppSyncSink};
 * reads back the contact list and recent history.
 */
export class WhatsAppStoreRepository implements WhatsAppSyncSink {
  constructor(private db: DrizzleDb) {}

  async upsertContacts(contacts: WaContactInput[]): Promise<void> {
    if (contacts.length === 0) return;
    const now = new Date();
    for (const chunk of chunked(contacts, UPSERT_CHUNK)) {
      await this.db
        .insert(waContacts)
        .values(
          chunk.map((c) => ({
            jid: c.jid,
            phoneNumber: c.phoneNumber ?? null,
            name: c.name ?? null,
            notify: c.notify ?? null,
            verifiedName: c.verifiedName ?? null,
            imgUrl: c.imgUrl ?? null,
            firstSyncedAt: now,
            updatedAt: now,
          })),
        )
        // coalesce(excluded, existing) so a partial `contacts.update` (e.g. a
        // bare presence/name delta) never wipes a field we already learned.
        .onConflictDoUpdate({
          target: waContacts.jid,
          set: {
            phoneNumber: sql`coalesce(excluded.phone_number, phone_number)`,
            name: sql`coalesce(excluded.name, name)`,
            notify: sql`coalesce(excluded.notify, notify)`,
            verifiedName: sql`coalesce(excluded.verified_name, verified_name)`,
            imgUrl: sql`coalesce(excluded.img_url, img_url)`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
  }

  async upsertChats(chats: WaChatInput[]): Promise<void> {
    if (chats.length === 0) return;
    const now = new Date();
    for (const chunk of chunked(chats, UPSERT_CHUNK)) {
      await this.db
        .insert(waChats)
        .values(
          chunk.map((c) => ({
            jid: c.jid,
            name: c.name ?? null,
            isGroup: c.isGroup,
            lastMessageAt: c.lastMessageAt ?? null,
            unreadCount: c.unreadCount ?? null,
            archived: c.archived ?? false,
            updatedAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: waChats.jid,
          set: {
            name: sql`coalesce(excluded.name, name)`,
            isGroup: sql`excluded.is_group`,
            lastMessageAt: sql`coalesce(excluded.last_message_at, last_message_at)`,
            unreadCount: sql`coalesce(excluded.unread_count, unread_count)`,
            archived: sql`excluded.archived`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
  }

  async upsertMessages(messages: WaMessageInput[]): Promise<void> {
    if (messages.length === 0) return;
    const now = new Date();
    for (const chunk of chunked(messages, UPSERT_CHUNK)) {
      // Messages are immutable; the first version we see (live or from history)
      // wins. The one exception heals data written before reactions were
      // understood: a reaction that an older sync stored as a contentless
      // 'other' row (the empty-bubble bug) is upgraded in place on the next
      // re-sync to carry its emoji + target. The `where` keeps this narrow —
      // it only fires when the incoming frame is a reaction and the stored row
      // wasn't yet linked to a target, so no other message type is ever mutated.
      await this.db
        .insert(waMessages)
        .values(
          chunk.map((m) => ({
            id: m.id,
            chatJid: m.chatJid,
            senderJid: m.senderJid ?? null,
            fromMe: m.fromMe,
            timestamp: m.timestamp,
            type: m.type ?? null,
            text: m.text ?? null,
            hasMedia: m.hasMedia,
            pushName: m.pushName ?? null,
            reactsToId: m.reactsToId ?? null,
            createdAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [waMessages.chatJid, waMessages.id],
          set: {
            type: sql`excluded.type`,
            text: sql`excluded.text`,
            reactsToId: sql`excluded.reacts_to_id`,
          },
          where: sql`excluded.type = 'reaction' AND ${waMessages.reactsToId} IS NULL`,
        });
    }
  }

  /**
   * The synced address book, newest-conversation-first then alphabetical,
   * each row annotated with whether it has been promoted to a `persons` entry.
   * Reads the table whole; callers paginate the result themselves.
   */
  async listContacts(): Promise<WhatsAppContactRow[]> {
    const rows = (await this.db.all(sql`
      WITH wa_threads AS (
        SELECT jid FROM wa_contacts
        UNION
        SELECT jid FROM wa_chats WHERE is_group = 1 OR jid LIKE '%@g.us'
      )
      SELECT
        t.jid AS jid,
        c.phone_number AS phoneNumber,
        c.name AS name,
        c.notify AS notify,
        c.verified_name AS verifiedName,
        c.img_url AS imgUrl,
        ch.name AS chatName,
        coalesce(ch.is_group, t.jid LIKE '%@g.us') AS isGroup,
        cm.person_id AS linkedPersonId,
        p.display_name AS linkedPersonName,
        -- Reactions are emoji pinned to another message, not a line of their
        -- own — exclude them so they never become a conversation's last message.
        (SELECT MAX(m.timestamp) FROM wa_messages m
           WHERE m.chat_jid = t.jid AND m.type IS NOT 'reaction') AS lastMessageAt,
        (SELECT m.text FROM wa_messages m
           WHERE m.chat_jid = t.jid AND m.type IS NOT 'reaction'
           ORDER BY m.timestamp DESC, m.rowid DESC LIMIT 1) AS lastMessagePreview,
        (SELECT COUNT(*) FROM wa_messages m WHERE m.chat_jid = t.jid) AS messageCount
      FROM wa_threads t
      LEFT JOIN wa_contacts c ON c.jid = t.jid
      LEFT JOIN wa_chats ch ON ch.jid = t.jid
      LEFT JOIN channel_mappings cm
        ON cm.channel = 'whatsapp' AND cm.channel_user_id = t.jid
      LEFT JOIN persons p ON p.id = cm.person_id
      WHERE NOT (
        t.jid LIKE '%@lid'
        AND c.phone_number IS NULL
        AND c.name IS NULL
        AND c.notify IS NULL
        AND c.verified_name IS NULL
        AND ch.name IS NULL
      )
      ORDER BY (lastMessageAt IS NULL) ASC, lastMessageAt DESC,
        lower(coalesce(c.name, c.notify, c.verified_name, ch.name, c.phone_number, t.jid)) ASC
    `)) as Array<Record<string, unknown>>;

    const mapped = rows.map((r) => ({
      jid: String(r.jid),
      phoneNumber: (r.phoneNumber as string | null) ?? null,
      name: (r.name as string | null) ?? null,
      notify: (r.notify as string | null) ?? null,
      verifiedName: (r.verifiedName as string | null) ?? null,
      imgUrl: (r.imgUrl as string | null) ?? null,
      chatName: (r.chatName as string | null) ?? null,
      isGroup: Boolean(r.isGroup),
      linkedPersonId: (r.linkedPersonId as string | null) ?? null,
      linkedPersonName: (r.linkedPersonName as string | null) ?? null,
      lastMessageAt: r.lastMessageAt == null ? null : Number(r.lastMessageAt),
      lastMessagePreview: (r.lastMessagePreview as string | null) ?? null,
      messageCount: Number(r.messageCount ?? 0),
    }));

    return consolidateByAccount(mapped);
  }

  /**
   * Recent mirrored messages for the channel-level history action. Returns a
   * bounded chronological slice, enriched with chat and sender display fields:
   * the newest `limit` at or after `since`, oldest first.
   */
  async fetchHistory(
    threadJid: string | null,
    since: Date,
    limit: number = HISTORY_READ_LIMIT,
  ): Promise<WaHistoryMessage[]> {
    const sinceSeconds = Math.floor(since.getTime() / 1000);
    const threadClause = threadJid != null ? sql`AND m.chat_jid = ${threadJid}` : sql``;
    const rows = (await this.db.all(sql`
      SELECT ${waHistoryColumns()}
      FROM wa_messages m
      ${WA_HISTORY_JOINS}
      WHERE m.timestamp >= ${sinceSeconds} ${threadClause}
      ORDER BY m.timestamp DESC, m.rowid DESC
      LIMIT ${Math.min(limit, HISTORY_READ_LIMIT)}
    `)) as Array<Record<string, unknown>>;

    return rows.map(waHistoryRow).reverse();
  }
}

/**
 * The fields a mirrored message is read with, each an alias and the expression
 * over `wa_messages m` and {@link WA_HISTORY_JOINS} that answers it. One list,
 * so the history read and the channel's per-account view read a row the same
 * way and {@link waHistoryRow} parses either.
 */
const WA_HISTORY_FIELDS: ReadonlyArray<readonly [string, SQL]> = [
  ["id", sql`m.id`],
  ["chatJid", sql`m.chat_jid`],
  ["chatName", sql`coalesce(ch.name, cc.name, cc.notify, cc.verified_name)`],
  ["chatPhoneNumber", sql`cc.phone_number`],
  ["isGroup", sql`coalesce(ch.is_group, m.chat_jid LIKE '%@g.us')`],
  ["senderJid", sql`m.sender_jid`],
  ["senderName", sql`coalesce(sc.name, sc.notify, sc.verified_name)`],
  ["senderPhoneNumber", sql`sc.phone_number`],
  ["fromMe", sql`m.from_me`],
  ["timestamp", sql`m.timestamp`],
  ["type", sql`m.type`],
  ["text", sql`m.text`],
  ["hasMedia", sql`m.has_media`],
  ["pushName", sql`m.push_name`],
  ["reactsToId", sql`m.reacts_to_id`],
];

/** The joins {@link WA_HISTORY_FIELDS} read through, after `FROM wa_messages m`. */
export const WA_HISTORY_JOINS = sql`
  LEFT JOIN wa_chats ch ON ch.jid = m.chat_jid
  LEFT JOIN wa_contacts cc ON cc.jid = m.chat_jid
  LEFT JOIN wa_contacts sc ON sc.jid = m.sender_jid`;

function waHistoryColumns(): SQL {
  return sql.join(
    WA_HISTORY_FIELDS.map(([alias, expression]) => sql`${expression} AS ${sql.raw(alias)}`),
    sql`, `,
  );
}

/** Every field of a mirrored message as one JSON object, for a query that
 *  carries the row through columns of its own. {@link waHistoryRow} parses it. */
export function waHistoryJson(): SQL {
  return sql`json_object(${sql.join(
    WA_HISTORY_FIELDS.map(([alias, expression]) => sql`${sql.raw(`'${alias}'`)}, ${expression}`),
    sql`, `,
  )})`;
}

/** A row read with {@link WA_HISTORY_FIELDS}, as a column set or as the JSON
 *  object {@link waHistoryJson} builds. */
export function waHistoryRow(r: Record<string, unknown>): WaHistoryMessage {
  return {
    id: String(r.id),
    chatJid: String(r.chatJid),
    chatName: (r.chatName as string | null) ?? null,
    chatPhoneNumber: (r.chatPhoneNumber as string | null) ?? null,
    isGroup: Boolean(r.isGroup),
    senderJid: (r.senderJid as string | null) ?? null,
    senderName: (r.senderName as string | null) ?? null,
    senderPhoneNumber: (r.senderPhoneNumber as string | null) ?? null,
    fromMe: Boolean(r.fromMe),
    timestamp: new Date(Number(r.timestamp) * 1000),
    type: (r.type as string | null) ?? null,
    text: (r.text as string | null) ?? null,
    hasMedia: Boolean(r.hasMedia),
    pushName: (r.pushName as string | null) ?? null,
    reactsToId: (r.reactsToId as string | null) ?? null,
  };
}

export function createWhatsAppStoreRepository(db: DrizzleDb): WhatsAppStoreRepository {
  return new WhatsAppStoreRepository(db);
}
