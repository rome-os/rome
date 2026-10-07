import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

const PREFIX = "connector__";

export const emittedEvents = sqliteTable(
  `${PREFIX}emitted_events`,
  {
    eventId: text("event_id").primaryKey(),
    topic: text("topic").notNull(),
    provider: text("provider").notNull(),
    eventType: text("event_type").notNull(),
    receivedAt: integer("received_at", { mode: "timestamp" }).notNull(),
    payloadJson: text("payload_json").notNull(),
    // Outbox state. A row is owed a publish to Rome's bus until `publishedAt`
    // is set. A publisher claims it first, and the claim lapses after a lease.
    publishedAt: integer("published_at", { mode: "timestamp" }),
    publishClaimedAt: integer("publish_claimed_at", { mode: "timestamp" }),
    publishAttempts: integer("publish_attempts").notNull().default(0),
  },
  (table) => [
    index("idx_connector_emitted_events_received_at").on(table.receivedAt),
    index("idx_connector_emitted_events_topic").on(table.topic),
  ],
);

export const settings = sqliteTable(`${PREFIX}settings`, {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});
