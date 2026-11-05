import { describe, expect, it, rs } from "@rstest/core";

import { ensurePinnedProject, type PinDeps, readPinnedProject } from "./composio-project.js";

/** The pin's dependencies over fakes: an in-memory store, two projects, and which one holds an endpoint. */
function deps(over: { endpointIn?: string; storedEndpoint?: string; apiKey?: string } = {}) {
  const store = new Map<string, string>();
  if (over.storedEndpoint) store.set("webhookEndpointId", over.storedEndpoint);
  const listProjects = rs.fn(async () => [
    { id: "pr_default", name: "Default" },
    { id: "pr_used", name: "Used" },
  ]);
  const value: PinDeps = {
    store: {
      get: async (key) => store.get(key) ?? null,
      set: async (key, v) => {
        store.set(key, v);
      },
    },
    apiKey: over.apiKey ?? "uak_test",
    orgId: async () => "ok_org",
    listProjects,
    clientFor: (project) => ({
      defaultProject: async () => ({
        projectId: "pr_default",
        projectName: "Default",
        orgId: "org-uuid",
      }),
      webhookSubscriptionExists: async (id) =>
        project?.projectId === over.endpointIn && id === over.storedEndpoint,
    }),
  };
  return { value, store, listProjects };
}

describe("ensurePinnedProject", () => {
  it("keeps a Rome that already registered a webhook on the project that holds it", async () => {
    const d = deps({ storedEndpoint: "ws_1", endpointIn: "pr_used" });
    await expect(ensurePinnedProject(d.value)).resolves.toEqual({
      orgId: "ok_org",
      projectId: "pr_used",
      projectName: "Used",
    });
    await expect(readPinnedProject(d.value.store)).resolves.toMatchObject({ projectId: "pr_used" });
  });

  it("pins the default when no project holds the stored endpoint", async () => {
    const d = deps({ storedEndpoint: "ws_gone" });
    await expect(ensurePinnedProject(d.value)).resolves.toMatchObject({ projectId: "pr_default" });
  });

  it("pins the default without listing projects when no endpoint is stored", async () => {
    const d = deps();
    await expect(ensurePinnedProject(d.value)).resolves.toMatchObject({
      orgId: "ok_org",
      projectId: "pr_default",
    });
    expect(d.listProjects).not.toHaveBeenCalled();
  });

  it("keeps an existing pin, and pins nothing for a project key", async () => {
    const d = deps({ storedEndpoint: "ws_1", endpointIn: "pr_used" });
    d.store.set(
      "composioProject",
      JSON.stringify({ orgId: "ok_org", projectId: "pr_kept", projectName: "Kept" }),
    );
    await expect(ensurePinnedProject(d.value)).resolves.toMatchObject({ projectId: "pr_kept" });
    const project = deps({ apiKey: "ak_test" });
    await expect(ensurePinnedProject(project.value)).resolves.toBeNull();
    expect(project.store.has("composioProject")).toBe(false);
  });
});
