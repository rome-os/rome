import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Single-row table holding the welcome-to-rome conversation's progress. The
// `node` column is the state-machine cursor: each user turn the
// middleware reads it, decides the scripted reply, runs any side effects, and
// advances it. Captured artifacts (the guardian's self-description, the folded
// memory summary, the brainstormed app ideas) are cached here so a reload or a
// backend restart resumes the conversation exactly where it left off rather
// than re-summoning the side-effect agents.
//
// Keyed by a fixed singleton id — onboarding is per-instance, so a handful of
// fields on one row is the right shape (mirrors the onboarding app's table).
export function createAppDbSchema(tablePrefix: string = "welcome_to_rome") {
  const progress = sqliteTable(`${tablePrefix}__progress`, {
    id: text("id").primaryKey(),
    // State-machine cursor. See NODES in hooks/turn-middleware/script.ts.
    node: text("node").notNull(),
    introRawInput: text("intro_raw_input"),
    introSummary: text("intro_summary"),
    // JSON-encoded AppIdea[] (`[{ title, prompt }]`).
    appIdeas: text("app_ideas"),
    appIdeasGeneratedAt: text("app_ideas_generated_at"),
    // Whether the connect-AI step ended with a provider logged in. Decides
    // whether the later steps summon agents or show static content.
    aiConnected: integer("ai_connected", { mode: "boolean" }),
    completedAt: text("completed_at"),
    updatedAt: text("updated_at").notNull(),
  });

  return { progress };
}

const defaultSchema = createAppDbSchema();
export const progress = defaultSchema.progress;
