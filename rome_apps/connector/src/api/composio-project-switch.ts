import type { ComposioClient } from "./composio-client.js";
import type { CliProject } from "./composio-login.js";
import { type PinnedProject, pinProject, readPinnedProject } from "./composio-project.js";
import type { SettingsStore } from "./settings-store.js";
import { ROME_USER_ID, subscribeTriggerFeed } from "../shared.js";

/** What the guardian reads after switching: connections stay with the project they were made in. */
export const PROJECT_SWITCH_NOTE =
  "Services connected in the previous project need connecting again here.";

type SwitchClient = Pick<
  ComposioClient,
  | "listActiveTriggers"
  | "getTriggerType"
  | "findActiveConnectedAccount"
  | "createTrigger"
  | "setWebhookUrl"
>;

export interface SwitchDeps {
  store: Pick<SettingsStore, "get" | "set" | "delete">;
  orgId(): Promise<string | null>;
  listProjects(): Promise<CliProject[]>;
  clientFor(project: { orgId: string; projectId: string }): SwitchClient;
  /** Points the project's webhook at this Rome and stores its signing secret. */
  registerWebhook(client: SwitchClient): Promise<void>;
}

export interface SwitchResult {
  project: PinnedProject;
  /** Triggers armed again in the new project, copied from the previous one. */
  rearmed: number;
  /** Triggers that could not be armed there, mostly for a service not connected in it. */
  notRearmed: number;
  /** Why the webhook could not be pointed here, when it could not. */
  webhookError?: string;
  note: string;
}

/** The account this Rome connects in the project for the trigger's service, or null when there is none. */
async function destinationAccount(
  client: SwitchClient,
  slug: string,
): Promise<{ toolkit: string; id: string } | null> {
  const toolkit = (await client.getTriggerType(slug)).toolkit.slug.toLowerCase();
  const resolved = await client.findActiveConnectedAccount(ROME_USER_ID, toolkit);
  return resolved.kind === "ok" ? { toolkit, id: resolved.id } : null;
}

const sameConfig = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Pins another project of the account and moves this Rome's Composio events
 * there: its webhook points here with a new signing secret, and every trigger
 * active in the previous project is armed again in the new one wherever its
 * service is connected there. The previous project is left as it was. When
 * the webhook cannot be pointed here, the stored signing material is dropped,
 * so Event delivery says it needs setup.
 */
export async function switchProject(deps: SwitchDeps, projectId: string): Promise<SwitchResult> {
  const project = (await deps.listProjects()).find((p) => p.id === projectId);
  if (!project) throw new Error(`No Composio project ${projectId} on this account.`);
  const orgId = (await deps.orgId()) ?? (await readPinnedProject(deps.store))?.orgId;
  if (!orgId) throw new Error("The Composio session names no organization.");
  const previous = await readPinnedProject(deps.store);
  const before = previous
    ? await deps
        .clientFor(previous)
        .listActiveTriggers()
        .catch(() => [])
    : [];

  const pinned = await pinProject(deps.store, {
    orgId,
    projectId: project.id,
    projectName: project.name,
  });
  const next = deps.clientFor(pinned);
  let webhookError: string | undefined;
  try {
    await deps.registerWebhook(next);
  } catch (err) {
    webhookError = err instanceof Error ? err.message : String(err);
    // The stored signing material belongs to the previous project. Without it,
    // Event delivery says it needs setup instead of looking ready.
    await deps.store.delete("webhookSecret");
    await deps.store.delete("webhookEndpointId");
  }

  let rearmed = 0;
  let notRearmed = 0;
  if (previous?.projectId !== pinned.projectId) {
    const already = await next.listActiveTriggers().catch(() => []);
    for (const trigger of before) {
      // Armed already only when it fires for the account this Rome connects in the new project.
      const account = await destinationAccount(next, trigger.triggerName).catch(() => null);
      if (!account) {
        notRearmed += 1;
        continue;
      }
      const armed = already.some(
        (t) =>
          t.triggerName.toUpperCase() === trigger.triggerName.toUpperCase() &&
          t.connectedAccountIds.includes(account.id) &&
          sameConfig(t.triggerConfig, trigger.triggerConfig),
      );
      if (armed) continue;
      const result = await subscribeTriggerFeed(next as ComposioClient, {
        slug: trigger.triggerName,
        config: trigger.triggerConfig,
        expectedToolkit: account.toolkit,
        connectedAccountId: account.id,
      }).catch(() => ({ ok: false as const }));
      if (result.ok) rearmed += 1;
      else notRearmed += 1;
    }
  }
  return {
    project: pinned,
    rearmed,
    notRearmed,
    ...(webhookError ? { webhookError } : {}),
    note: PROJECT_SWITCH_NOTE,
  };
}
