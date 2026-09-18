import "dotenv/config";
import { join } from "path";
import { homedir } from "os";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema/system.ts",
  out: "./drizzle/system",
  dialect: "sqlite",
  migrations: { table: "__drizzle_migrations_system" },
  tablesFilter: [
    "reply_delivery_parts",
    "events",
    "sessions",
    "session_turn_checkpoints",
    "persons",
    "channel_mappings",
    "sentinel_log",
    "approvals",
    "settings",
    "app_keys",
    "policies",
    "guardian_auth",
    "provider_accounts",
    "oauth_pending_attempts",
    "webchat_projects",
    "webchat_sessions",
    "webchat_workspace_layouts",
    "action_executions",
    "webhook_invocations",
    "webchat_messages",
    "webchat_trace_blocks",
    "webchat_turn_feedback",
    "routines",
    "routine_runs",
    "execution_journal",
    "connections",
    "connection_grants",
    "rome_sessions",
    "linkedin_threads",
    "linkedin_messages",
    "linkedin_participants",
    "linkedin_thread_participants",
  ],
  dbCredentials: {
    url:
      process.env.SQLITE_PATH ??
      join(homedir(), ".rome", process.env.ROME_PROFILE || "default", "rome.db"),
  },
});
