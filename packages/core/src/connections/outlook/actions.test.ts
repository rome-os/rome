import { describe, expect, it, rs } from "@rstest/core";
import { ActionRegistryImpl } from "../../apps/actions/registry.js";
import { withForwardedApprovalId } from "../approved-send.js";
import type { ConnectionRegistry } from "../registry.js";
import { OUTLOOK_READ_ACTION, OUTLOOK_SEND_ACTION, registerOutlookActions } from "./actions.js";

const message = {
  connectionId: "microsoft-1",
  from: "guardian@example.com",
  to: ["friend@example.com"],
  subject: "Hello",
  body: "Exact body",
};
const SCOPES = ["openid", "User.Read", "Mail.Read", "Mail.Send"];
function harness(entries?: unknown[], scopes = SCOPES) {
  const invoke = rs.fn().mockResolvedValue({ status: 200, data: { id: "me" }, headers: {} });
  const actions = new ActionRegistryImpl();
  registerOutlookActions(
    actions,
    {
      grantOf: async () => ({ profile: { scopes } }),
      find: () => entries ?? [{ id: "microsoft-1", state: () => "working", act: { invoke } }],
    } as unknown as ConnectionRegistry,
    { claimApprovedSend: async () => true },
  );
  return { actions, invoke };
}
const read = (actions: ActionRegistryImpl, path = "/v1.0/me") =>
  actions.get(OUTLOOK_READ_ACTION)!.execute({ path });

describe("Outlook actions", () => {
  it("requires approval for every send and previews the exact message", async () => {
    const { actions, invoke } = harness();
    const send = actions.get(OUTLOOK_SEND_ACTION)!;
    expect(send.config.requiresApproval).toBe(true);
    expect(await send.preview!(message)).toMatchObject({
      kind: "generic",
      fields: [
        { label: "From", value: message.from },
        { label: "To", value: message.to[0] },
        { label: "Subject", value: message.subject },
        { label: "Body", value: message.body },
      ],
    });
    expect(await send.execute(message)).toMatchObject({ status: "error" });
    expect(invoke).not.toHaveBeenCalled();
    expect(
      await withForwardedApprovalId("test-approved", () => send.execute(message)),
    ).toMatchObject({ status: "ok", data: { connectionId: "microsoft-1" } });
    expect(invoke).toHaveBeenCalledWith({ operation: "send", input: message });
  });

  it("refuses an approval for another connection and invalid messages", async () => {
    const { actions, invoke } = harness();
    const send = actions.get(OUTLOOK_SEND_ACTION)!;
    for (const input of [
      { ...message, connectionId: "old-account" },
      { ...message, bcc: ["hidden@example.com"] },
    ]) {
      expect(
        await withForwardedApprovalId("test-approved", () => send.execute(input)),
      ).toMatchObject({ status: "error" });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("falls back only when no Microsoft account is connected, not when a grant is broken", async () => {
    expect(await read(harness([]).actions, "/anything")).toMatchObject({
      status: "error",
      error: expect.stringContaining("outlook_not_connected:"),
    });
    expect(
      await read(harness([{ id: "broken", state: () => "broken", act: null }]).actions),
    ).toMatchObject({
      status: "error",
      error: expect.not.stringContaining("outlook_not_connected:"),
    });
  });

  it("accepts Graph scopes with or without the resource prefix", async () => {
    const prefixed = SCOPES.map((scope) => `https://graph.microsoft.com/${scope}`);
    const { actions } = harness(undefined, prefixed);
    expect(await read(actions)).toMatchObject({ status: "ok" });
    expect(
      await withForwardedApprovalId("test-approved", () =>
        actions.get(OUTLOOK_SEND_ACTION)!.execute(message),
      ),
    ).toMatchObject({ status: "ok" });
  });

  it("leaves Composio available for an identity-only grant, and refuses ungranted sends", async () => {
    const identityOnly = harness(undefined, ["openid", "email", "profile"]);
    expect(await read(identityOnly.actions)).toMatchObject({
      error: expect.stringContaining("outlook_not_connected:"),
    });
    const readOnly = harness(undefined, ["User.Read", "Mail.Read"]);
    expect(await read(readOnly.actions)).toMatchObject({ status: "ok" });
    readOnly.invoke.mockClear();
    expect(
      await withForwardedApprovalId("test-approved", () =>
        readOnly.actions.get(OUTLOOK_SEND_ACTION)!.execute(message),
      ),
    ).toMatchObject({ status: "error", error: expect.stringContaining("Nothing was sent") });
    expect(readOnly.invoke).not.toHaveBeenCalled();
  });

  it("does not retry uncertain send outcomes, and reports provider errors", async () => {
    const { actions, invoke } = harness();
    invoke.mockRejectedValue(new Error("timeout"));
    expect(
      await withForwardedApprovalId("test-approved", () =>
        actions.get(OUTLOOK_SEND_ACTION)!.execute(message),
      ),
    ).toMatchObject({
      status: "error",
      error: expect.stringContaining("do not automatically retry"),
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    invoke.mockResolvedValue({ status: 403, data: {}, headers: {} });
    expect(await read(actions)).toMatchObject({
      status: "error",
      error: expect.stringContaining("403"),
    });
  });
});
