import { afterEach, expect, it, rs } from "@rstest/core";
import { callAction } from "../../apps/actions/call-action.js";
import { createTestRome, type TestRome } from "../../test/kit/index.js";
import type { ConnectionRegistry } from "../registry.js";
import { GMAIL_SEND_ACTION, registerGmailActions } from "./actions.js";

let rome: TestRome;
afterEach(async () => {
  await rome?.cleanup();
});
const message = {
  connectionId: "google-1",
  from: "guardian@example.com",
  to: ["recipient@example.com"],
  subject: "Exact subject",
  body: "Exact body\nSecond line",
};

it("parks every direct, nested and scheduled send before Gmail; approving sends only the stored message once", async () => {
  const invoke = rs.fn().mockResolvedValue({ status: 200, data: { id: "sent" }, headers: {} });
  const cards: unknown[] = [];
  rome = await createTestRome({
    engine: {
      onApprovalCreated: (card) => {
        cards.push(card);
      },
    },
  });
  registerGmailActions(
    rome.actionRegistry,
    {
      grantOf: async () => ({
        profile: {
          scopes: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
          ],
        },
      }),
      find: () => [{ id: "google-1", state: () => "working", act: { invoke } }],
    } as unknown as ConnectionRegistry,
    {
      claimApprovedSend: (id, argsHash) =>
        rome.repos.approvals.claimApprovedEffect(id, GMAIL_SEND_ACTION, argsHash),
    },
  );
  rome.actionRegistry.register({
    config: {
      name: "test:scheduled_gmail",
      type: "custom",
      description: "scheduled send",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "write",
    },
    execute: () => callAction(GMAIL_SEND_ACTION, message),
  });

  for (const name of [GMAIL_SEND_ACTION, "test:scheduled_gmail"]) {
    const pending = await rome.actionEngine.run(name, name === GMAIL_SEND_ACTION ? message : {}, {
      initiator: "routine:test",
    });
    expect(pending.status).toBe("pending_approval");
    expect(invoke).not.toHaveBeenCalled();
  }
  expect(cards).toHaveLength(2);
  expect(cards[0]).toMatchObject({
    actionName: GMAIL_SEND_ACTION,
    args: message,
    preview: {
      fields: [
        { label: "From", value: message.from },
        { label: "To", value: message.to[0] },
        { label: "Subject", value: message.subject },
        { label: "Body", value: message.body },
      ],
    },
  });
  const first = cards[0] as { approvalId: string };
  await rome.repos.approvals.resolvePending(first.approvalId, "approve", "guardian");
  await rome.approvalHandler.onApproved(first.approvalId);
  await rome.approvalHandler.onApproved(first.approvalId);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith({ operation: "send", input: message });

  const rejected = cards[1] as { approvalId: string };
  await rome.repos.approvals.resolvePending(rejected.approvalId, "reject", "guardian");
  await rome.approvalHandler.onApproved(rejected.approvalId);
  expect(invoke).toHaveBeenCalledTimes(1);
  const next = await rome.actionEngine.run(GMAIL_SEND_ACTION, { ...message, body: "Changed body" });
  expect(next.status).toBe("pending_approval");
  expect(invoke).toHaveBeenCalledTimes(1);
});
