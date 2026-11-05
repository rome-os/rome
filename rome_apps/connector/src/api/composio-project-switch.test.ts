import { describe, expect, it, rs } from "@rstest/core";

import { keptActiveTriggers } from "./active-triggers.js";
import type { ActiveTrigger } from "./composio-client.js";
import { PROJECT_SWITCH_NOTE, switchProject, type SwitchDeps } from "./composio-project-switch.js";
import { composioWebhookTarget } from "./composio-webhook.js";

const trigger = (name: string, config: Record<string, unknown> = {}): ActiveTrigger => ({
  triggerInstanceId: `ti_${name}`,
  triggerName: name,
  connectedAccountIds: ["ca_old"],
  triggerConfig: config,
  updatedAt: "2026-11-04T00:00:00Z",
});

describe("switchProject", () => {
  it("re-pins, points the webhook here, drops kept reads, and arms the previous triggers again", async () => {
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

    // Reads kept before the switch.
    const listActiveTriggers = rs.fn(async () => []);
    await keptActiveTriggers({ listActiveTriggers }, Date.now());
    const getWebhookUrl = rs.fn(async () => "https://relay.example/h/other");
    const relay = { get: async () => ({ depositUrl: "https://relay.example/h/switch" }) };
    await composioWebhookTarget({ client: { getWebhookUrl }, settings: relay });

    const result = await switchProject(
      {
        store: {
          get: async (key) => store.get(key) ?? null,
          set: async (key, value) => {
            store.set(key, value);
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
    await keptActiveTriggers({ listActiveTriggers }, Date.now());
    expect(listActiveTriggers).toHaveBeenCalledTimes(2);
    await composioWebhookTarget({ client: { getWebhookUrl }, settings: relay });
    expect(getWebhookUrl).toHaveBeenCalledTimes(2);
  });

  it("refuses a project the account does not have, and changes nothing", async () => {
    const set = rs.fn();
    await expect(
      switchProject(
        {
          store: { get: async () => null, set },
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
