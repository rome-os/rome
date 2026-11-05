import { eq } from "drizzle-orm";
import type { AppDbContext } from "@rome-os/app-runtime";
import { settings } from "../db/schema.js";

// The Composio API key is NOT a setting — it lives in the CLI session
// (`~/.composio/user_data.json`), read live via `readSessionApiKey`. Only the
// webhook subscription Rome registers upstream is app-owned state.
//
// `githubWebhookSecret` is the HMAC secret for Rome's OWN GitHub webhook (no
// Composio): `connector_github_subscribe` mints it and registers it on the
// repo/org hook, and the `/webhook` handler's GitHub branch verifies inbound
// `X-Hub-Signature-256` against it. One secret per instance, shared by every
// GitHub hook Rome registers.
//
// `composioProject` pins the Composio project a user key addresses, as JSON
// `{ orgId, projectId, projectName }` (see `composio-project.ts`).
export type SettingsKey =
  | "webhookSecret"
  | "webhookEndpointId"
  | "githubWebhookSecret"
  | "composioProject";

export class SettingsStore {
  constructor(private readonly db: AppDbContext) {}

  async get(key: SettingsKey): Promise<string | null> {
    const rows = await this.db.connection.select().from(settings).where(eq(settings.key, key));
    return rows[0]?.value ?? null;
  }

  async set(key: SettingsKey, value: string): Promise<void> {
    await this.db.connection
      .insert(settings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  async delete(key: SettingsKey): Promise<void> {
    await this.db.connection.delete(settings).where(eq(settings.key, key));
  }
}
