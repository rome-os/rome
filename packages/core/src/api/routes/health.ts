import { Hono } from "hono";
import { sql, type SQL } from "drizzle-orm";
import type { ApiDeps } from "../deps.js";

export type HealthDeps = Pick<ApiDeps, "db">;

interface SchemaProbe {
  name: string;
  query: SQL;
}

const REQUIRED_SCHEMA_PROBES: readonly SchemaProbe[] = [
  {
    name: "system_migrations",
    query: sql`SELECT "id" FROM "__drizzle_migrations_system" LIMIT 0`,
  },
  { name: "settings", query: sql`SELECT "key", "value", "updated_at" FROM "settings" LIMIT 0` },
  {
    name: "guardian_auth",
    query: sql`SELECT "id", "user_id", "onboarding_complete" FROM "guardian_auth" LIMIT 0`,
  },
  {
    name: "webchat_projects",
    query: sql`SELECT "id", "name", "path", "archived_at" FROM "webchat_projects" LIMIT 0`,
  },
  {
    name: "rome_sessions",
    query: sql`SELECT "id", "type", "source_thread_id", "chat_id", "account_id", "trigger_kind", "handoff_spec", "archived_at", "pinned_at", "activity_at", "last_seen_activity_at" FROM "rome_sessions" LIMIT 0`,
  },
  {
    name: "rome_agent_messages",
    query: sql`SELECT "id", "session_id", "turn_id", "trigger_kind", "input_tokens", "cost_usd" FROM "rome_agent_messages" LIMIT 0`,
  },
  {
    name: "chats",
    query: sql`SELECT "id", "platform", "kind", "name", "started_at" FROM "chats" LIMIT 0`,
  },
  {
    name: "chat_messages",
    query: sql`SELECT "id", "chat_id", "thread_id", "sender_account_id", "sender_agent", "parts", "reply_to_message_id", "said_at" FROM "chat_messages" LIMIT 0`,
  },
  {
    name: "agent_turn_messages",
    query: sql`SELECT "message_id", "session_id", "turn_id", "role", "input_state" FROM "agent_turn_messages" LIMIT 0`,
  },
  {
    name: "rome_agent_trace_blocks",
    query: sql`SELECT "message_id", "seq", "session_id", "content" FROM "rome_agent_trace_blocks" LIMIT 0`,
  },
  {
    name: "webchat_workspace_layouts",
    query: sql`SELECT "session_id", "layout", "updated_at" FROM "webchat_workspace_layouts" LIMIT 0`,
  },
  {
    name: "webchat_turn_feedback",
    query: sql`SELECT "session_id", "turn_id", "rating", "updated_at" FROM "webchat_turn_feedback" LIMIT 0`,
  },
  {
    name: "shared_chats",
    query: sql`SELECT "id", "session_id", "snapshot", "layout", "revoked_at" FROM "shared_chats" LIMIT 0`,
  },
  {
    name: "actions",
    query: sql`SELECT "id", "root_execution_id", "status", "cancel_requested_at" FROM "action_executions" LIMIT 0`,
  },
  {
    name: "routines",
    query: sql`SELECT "id", "name", "trigger", "next_run_at" FROM "routines" LIMIT 0`,
  },
];

export type HealthReadiness =
  | { ok: true }
  | { ok: false; failedCheck: "database" | `schema:${string}`; error: string };

export async function checkHealthReadiness(deps: HealthDeps): Promise<HealthReadiness> {
  try {
    await deps.db.all(sql`SELECT 1`);
  } catch (err) {
    return { ok: false, failedCheck: "database", error: describeError(err) };
  }

  for (const probe of REQUIRED_SCHEMA_PROBES) {
    try {
      await deps.db.all(probe.query);
    } catch (err) {
      return { ok: false, failedCheck: `schema:${probe.name}`, error: describeError(err) };
    }
  }

  return { ok: true };
}

export function healthRoutes(deps: HealthDeps): Hono {
  const app = new Hono();
  app.get("/health", async (c) => {
    const readiness = await checkHealthReadiness(deps);
    if (!readiness.ok) {
      return c.json(
        {
          status: "degraded",
          failedCheck: readiness.failedCheck,
        },
        503,
      );
    }

    return c.json({ status: "ok" });
  });
  return app;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
