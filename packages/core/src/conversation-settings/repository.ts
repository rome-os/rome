import { and, asc, eq, like } from "drizzle-orm";
import type {
  ConversationDescriptor,
  ConversationId,
  StoredConversationSettings,
} from "@rome-os/app-runtime";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import { channelConversationId } from "../db/repositories/webchat.js";
import { romeAgentMessages, romeSessions } from "../db/schema/system.js";
import { assertProviderSessionResetPolicy } from "./reset-policy.js";
import { DEFAULT_WEBCHAT_PROJECT_NAME } from "../webchat/constants.js";

export type StoredConversationRow = typeof romeSessions.$inferSelect;

function rowByAddress(
  exec: DrizzleDb | DrizzleTx,
  service: string,
  conversationId: ConversationId,
) {
  return exec
    .select()
    .from(romeSessions)
    .where(
      and(
        eq(romeSessions.type, "channel"),
        eq(romeSessions.sourceChannel, service),
        eq(romeSessions.sourceThreadId, conversationId),
      ),
    )
    .limit(1)
    .get();
}

export class ConversationSettingsRepository {
  constructor(private readonly db: DrizzleDb) {}

  find(service: string, conversationId: ConversationId): StoredConversationRow | null {
    return rowByAddress(this.db, service, conversationId) ?? null;
  }

  listKnown(input: { service?: string; query?: string }): StoredConversationRow[] {
    const predicates = [eq(romeSessions.type, "channel")];
    if (input.service) {
      predicates.push(eq(romeSessions.sourceChannel, input.service));
    }
    if (input.query?.trim()) {
      predicates.push(like(romeSessions.sourceThreadName, `%${input.query.trim()}%`));
    }
    return this.db
      .select()
      .from(romeSessions)
      .where(and(...predicates))
      .orderBy(asc(romeSessions.sourceChannel), asc(romeSessions.sourceThreadName))
      .all();
  }

  hasMessageHistory(sessionId: string): boolean {
    return (
      this.db
        .select({ id: romeAgentMessages.id })
        .from(romeAgentMessages)
        .where(eq(romeAgentMessages.sessionId, sessionId))
        .limit(1)
        .get() !== undefined
    );
  }

  /** Create if missing, then mutate one aggregate in one SQLite transaction. Callers
   * serialize by address before entering this method. */
  mutate(
    descriptor: ConversationDescriptor,
    input: {
      settings: StoredConversationSettings | null;
      agentName: string | null | undefined;
    },
  ): StoredConversationRow {
    return this.db.transaction((tx) => {
      const sourceThreadType = descriptor.kind === "dm" ? "private" : descriptor.kind;
      const parentSessionId = descriptor.parent
        ? (rowByAddress(tx, descriptor.service, descriptor.parent.conversationId)?.id ?? null)
        : null;
      const now = new Date();
      tx.insert(romeSessions)
        .values({
          id: channelConversationId(descriptor.service, descriptor.ref.conversationId),
          name: descriptor.displayName,
          personaId: null,
          projectName: DEFAULT_WEBCHAT_PROJECT_NAME,
          projectPath: null,
          largeModelSelection: null,
          agentName: null,
          type: "channel",
          sourceChannel: descriptor.service,
          sourceThreadId: descriptor.ref.conversationId,
          sourceThreadName: descriptor.displayName,
          sourceThreadType,
          channelSettings: null,
          parentSessionId,
          createdAt: now,
          activityAt: now,
          lastSeenActivityAt: null,
        })
        .onConflictDoNothing({ target: romeSessions.id })
        .run();

      const current = rowByAddress(tx, descriptor.service, descriptor.ref.conversationId);
      if (!current) {
        throw new Error(
          `Failed to resolve conversation ${descriptor.service}:${descriptor.ref.conversationId}`,
        );
      }

      tx.update(romeSessions)
        .set({
          name: descriptor.displayName,
          sourceChannel: descriptor.service,
          sourceThreadName: descriptor.displayName,
          sourceThreadType,
          parentSessionId,
          channelSettings: input.settings,
          ...(input.agentName !== undefined ? { agentName: input.agentName } : {}),
        })
        .where(eq(romeSessions.id, current.id))
        .run();

      const saved = rowByAddress(tx, descriptor.service, descriptor.ref.conversationId);
      if (!saved) throw new Error(`Conversation ${current.id} disappeared during settings update`);
      return saved;
    });
  }
}

export function storedSettings(row: StoredConversationRow): StoredConversationSettings | null {
  if (!row.channelSettings || typeof row.channelSettings !== "object") return null;
  const value = row.channelSettings as Partial<StoredConversationSettings>;
  if (value.schemaVersion !== 1 || !value.overrides || typeof value.updatedAt !== "string") {
    throw new Error(`Invalid channel_settings payload on conversation "${row.id}"`);
  }
  const reset = value.overrides.session?.reset;
  if (reset !== undefined) assertProviderSessionResetPolicy(reset);
  return value as StoredConversationSettings;
}
