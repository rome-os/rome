import { describe, expect, it, rs } from "@rstest/core";

import type { ActiveTrigger } from "./composio-client.js";
import { PROJECT_SWITCH_NOTE, switchProject, type SwitchDeps } from "./composio-project-switch.js";

const trigger = (name: string, config: Record<string, unknown> = {}): ActiveTrigger => ({
  triggerInstanceId: `ti_${name}`,
  triggerName: name,
  connectedAccountIds: ["ca_old"],
  triggerConfig: config,
  updatedAt: "2026-11-04T00:00:00Z",
});

describe("switchProject", () => {
  it("re-pins, points the webhook here, and arms the previous triggers again", async () => {
    const store = new Map<string, string>([
      [
        "composioProject",
        JSON.stringify({ orgId: "ok_org", projectId: "pr_old", projectName: "Old" }),
      ],
    ]);
    const created: { slug: string; account: string }[] = [];
    const registerWebhook = rs.fn(async () => {});
    const clientFor: SwitchDeps["clientFor"] = (project) => ({
      listActiveTriggers: async () =>
        project.projectId === "pr_old"
          ? [trigger("MAIL_NEW", { label: "INBOX" }), trigger("CHAT_NEW"), trigger("ISSUE_NEW")]
          : [trigger("ISSUE_NEW")],
      getTriggerType: async (slug) =>
        ({ slug, toolkit: { slug: slug.split("_")[0]!.toLowerCase() } }) as never,
      // Only mail is connected in the new project.
      findActiveConnectedAccount: async (_user, toolkit) =>
        toolkit === "mail" ? { kind: "ok", id: "ca_new" } : { kind: "none" },
      createTrigger: async (_user, slug, opts) => {
        created.push({ slug, account: opts.connectedAccountId });
        return { triggerInstanceId: "ti_created" };
      },
      setWebhookUrl: async () => ({ id: "ws_new", secret: "whsec_new" }),
    });

    const result = await switchProject(
      {
        store: {
          get: async (key) => store.get(key) ?? null,
          set: async (key, value) => {
            store.set(key, value);
          },
          delete: async (key) => {
            store.delete(key);
          },
        },
        orgId: async () => "ok_org",
        listProjects: async () => [
          { id: "pr_old", name: "Old" },
          { id: "pr_new", name: "New" },
        ],
        clientFor,
        registerWebhook,
      },
      "pr_new",
    );

    expect(result).toEqual({
      project: { orgId: "ok_org", projectId: "pr_new", projectName: "New" },
      rearmed: 1,
      notRearmed: 1,
      note: PROJECT_SWITCH_NOTE,
    });
    expect(JSON.parse(store.get("composioProject") ?? "null").projectId).toBe("pr_new");
    expect(registerWebhook).toHaveBeenCalledTimes(1);
    expect(created).toEqual([{ slug: "MAIL_NEW", account: "ca_new" }]);
  });

  it("drops the stored signing material when the new project's webhook cannot point here", async () => {
    const store = new Map<string, string>([
      ["webhookSecret", "whsec_old"],
      ["webhookEndpointId", "ws_old"],
    ]);
    const result = await switchProject(
      {
        store: {
          get: async (key) => store.get(key) ?? null,
          set: async (key, value) => {
            store.set(key, value);
          },
          delete: async (key) => {
            store.delete(key);
          },
        },
        orgId: async () => "ok_org",
        listProjects: async () => [{ id: "pr_new", name: "New" }],
        clientFor: () => ({ listActiveTriggers: async () => [] }) as never,
        registerWebhook: async () => {
          throw new Error("relay unavailable");
        },
      },
      "pr_new",
    );
    expect(result.webhookError).toBe("relay unavailable");
    expect(store.has("webhookSecret")).toBe(false);
    expect(store.has("webhookEndpointId")).toBe(false);
    expect(JSON.parse(store.get("composioProject") ?? "null").projectId).toBe("pr_new");
  });

  it("refuses a project the account does not have, and changes nothing", async () => {
    const set = rs.fn();
    await expect(
      switchProject(
        {
          store: { get: async () => null, set, delete: rs.fn() },
          orgId: async () => "ok_org",
          listProjects: async () => [{ id: "pr_old", name: "Old" }],
          clientFor: () => ({}) as never,
          registerWebhook: rs.fn(),
        },
        "pr_missing",
      ),
    ).rejects.toThrow("No Composio project pr_missing");
    expect(set).not.toHaveBeenCalled();
  });
});
