import { describe, expect, it, rs } from "@rstest/core";
import { ActionRegistryImpl } from "../../apps/actions/registry.js";
import type { ConnectionRegistry } from "../registry.js";
import { GMAIL_READ_ACTION, GMAIL_SEND_ACTION, registerGmailActions } from "./actions.js";

const message = {
  connectionId: "google-1",
  from: "guardian@example.com",
  to: ["friend@example.com"],
  subject: "Hello",
  body: "Exact body",
};
function harness(entries?: unknown[]) {
  const invoke = rs.fn().mockResolvedValue({ status: 200, data: { id: "message-1" }, headers: {} });
  const actions = new ActionRegistryImpl();
  registerGmailActions(actions, {
    find: () => entries ?? [{ id: "google-1", state: () => "working", act: { invoke } }],
  } as unknown as ConnectionRegistry);
  return { actions, invoke };
}

describe("Gmail actions", () => {
  it("requires approval for every send and previews the exact typed message", async () => {
    const { actions, invoke } = harness();
    const send = actions.get(GMAIL_SEND_ACTION)!;
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
    expect(invoke).not.toHaveBeenCalled();
    expect(await send.execute(message)).toMatchObject({ status: "ok" });
    expect(invoke).toHaveBeenCalledWith({ operation: "send", input: message });
  });

  it("refuses an approval for a removed/replaced connection and invalid message inputs", async () => {
    const { actions, invoke } = harness();
    const send = actions.get(GMAIL_SEND_ACTION)!;
    for (const input of [
      { ...message, connectionId: "old-account" },
      { ...message, bcc: "hidden@example.com" },
    ]) {
      expect(await send.execute(input)).toMatchObject({ status: "error" });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("falls back only when no Google account is connected, not when a grant is broken", async () => {
    expect(
      await harness([]).actions.get(GMAIL_READ_ACTION)!.execute({ path: "/anything" }),
    ).toMatchObject({ status: "error", error: expect.stringContaining("gmail_not_connected:") });
    expect(
      await harness([{ id: "broken", state: () => "broken", act: null }])
        .actions.get(GMAIL_READ_ACTION)!
        .execute({ path: "/gmail/v1/users/me/profile" }),
    ).toMatchObject({
      status: "error",
      error: expect.not.stringContaining("gmail_not_connected:"),
    });
  });

  it("does not retry provider errors or uncertain send outcomes", async () => {
    const { actions, invoke } = harness();
    invoke.mockRejectedValue(new Error("timeout"));
    expect(await actions.get(GMAIL_SEND_ACTION)!.execute(message)).toMatchObject({
      status: "error",
      error: expect.stringContaining("do not automatically retry"),
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    invoke.mockResolvedValue({ status: 403, data: {}, headers: {} });
    expect(
      await actions.get(GMAIL_READ_ACTION)!.execute({ path: "/gmail/v1/users/me/profile" }),
    ).toMatchObject({ status: "error", error: expect.stringContaining("403") });
  });
});
