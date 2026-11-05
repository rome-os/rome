import type { AppDbContext } from "@rome-os/app-runtime";

import { ComposioClient } from "./composio-client.js";
import { type CliProject, listCliProjects, readSessionOrgId } from "./composio-login.js";
import { SettingsStore } from "./settings-store.js";

/**
 * The one Composio project this Rome uses. A user key (`uak_`) reaches every
 * project of its account and, with no project named, Composio's default one,
 * which moves when the guardian creates another project. Pinning keeps this
 * Rome's connections, triggers and webhook in one project, and lets two Romes
 * on one account use separate projects. A project key (`ak_`) is fixed to its
 * project and needs no pin.
 */
export interface PinnedProject {
  orgId: string;
  projectId: string;
  projectName: string;
}

type ProjectRef = { orgId: string; projectId: string };

export interface PinDeps {
  store: Pick<SettingsStore, "get" | "set">;
  apiKey: string;
  /** The CLI session's organization id, which the project headers carry. */
  orgId(): Promise<string | null>;
  listProjects(): Promise<CliProject[]>;
  /** A client for the key, addressing `project`, or the default project when null. */
  clientFor(
    project: ProjectRef | null,
  ): Pick<ComposioClient, "defaultProject" | "webhookSubscriptionExists">;
}

export async function readPinnedProject(
  store: Pick<SettingsStore, "get">,
): Promise<PinnedProject | null> {
  const raw = await store.get("composioProject");
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PinnedProject>;
    return typeof value.orgId === "string" && typeof value.projectId === "string"
      ? {
          orgId: value.orgId,
          projectId: value.projectId,
          projectName: value.projectName ?? value.projectId,
        }
      : null;
  } catch {
    return null;
  }
}

export async function pinProject(
  store: Pick<SettingsStore, "set">,
  project: PinnedProject,
): Promise<PinnedProject> {
  await store.set("composioProject", JSON.stringify(project));
  return project;
}

/** Pins the key's default project, as Composio's session info names it. */
export async function pinDefaultProject(deps: PinDeps): Promise<PinnedProject> {
  const fallback = await deps.clientFor(null).defaultProject();
  const orgId = (await deps.orgId()) ?? fallback.orgId;
  if (!orgId) throw new Error("The Composio session names no organization");
  return pinProject(deps.store, {
    orgId,
    projectId: fallback.projectId,
    projectName: fallback.projectName,
  });
}

/**
 * The pinned project, pinning one first when there is none, or when the pin
 * belongs to another Composio organization than the signed-in one: the
 * project that holds this Rome's stored webhook endpoint, so a Rome that
 * already uses a project stays on it, and otherwise the default. The pin
 * outlives signing out, so signing in again keeps the same project. Null for
 * a project key.
 */
export async function ensurePinnedProject(deps: PinDeps): Promise<PinnedProject | null> {
  if (!deps.apiKey.startsWith("uak_")) return null;
  const pinned = await readPinnedProject(deps.store);
  const orgId = await deps.orgId();
  if (pinned && (!orgId || pinned.orgId === orgId)) return pinned;
  const endpointId = await deps.store.get("webhookEndpointId");
  if (endpointId && orgId) {
    for (const project of await deps.listProjects()) {
      const client = deps.clientFor({ orgId, projectId: project.id });
      if (await client.webhookSubscriptionExists(endpointId)) {
        return pinProject(deps.store, { orgId, projectId: project.id, projectName: project.name });
      }
    }
  }
  return pinDefaultProject(deps);
}

/** The live dependencies: this app's settings, the CLI session and project list, and Composio. */
export function livePinDeps(db: AppDbContext, apiKey: string): PinDeps & { store: SettingsStore } {
  return {
    store: new SettingsStore(db),
    apiKey,
    orgId: readSessionOrgId,
    listProjects: listCliProjects,
    clientFor: (project) => new ComposioClient({ apiKey, project }),
  };
}

// Concurrent first reads share one pinning.
let pinning: Promise<PinnedProject | null> | null = null;

/**
 * The project a client for `apiKey` should address. When pinning fails
 * (Composio or the CLI unreachable), it answers null, so the client uses the
 * default project as before, and the next call tries again.
 */
export async function pinnedProjectFor(
  db: AppDbContext,
  apiKey: string,
): Promise<PinnedProject | null> {
  pinning ??= ensurePinnedProject(livePinDeps(db, apiKey))
    .catch(() => null)
    .finally(() => {
      pinning = null;
    });
  return pinning;
}
