import { afterEach, expect, it, rs } from "@rstest/core";
import { AsyncResource } from "node:async_hooks";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { IpcRpc, type IpcMessage, type IpcTransport } from "../apps/actions/ipc.js";
import { WorkerRpcServer, type WorkerRpcServices } from "../apps/actions/worker-rpc.js";
import type { ActionResult } from "../apps/actions/types.js";
import { callAction } from "../apps/actions/call-action.js";
import {
  GMAIL_READ_ACTION,
  GMAIL_SEND_ACTION,
  registerGmailActions,
} from "../connections/gmail/actions.js";
import type { ConnectionRegistry } from "../connections/registry.js";
import { createTestRome, type TestRome } from "../test/kit/index.js";
import { gmailWorkerCalls, registerGmailActionProxies } from "./gmail-calls.js";

let rome: TestRome;
const cleanup: (() => void)[] = [];
afterEach(async () => {
  cleanup.splice(0).forEach((close) => close());
  await rome?.cleanup();
});

function peers(server: WorkerRpcServer) {
  const mainInbox = new Set<(message: IpcMessage) => void>();
  const workerInbox = new Set<(message: IpcMessage) => void>();
  const mainContext = new AsyncResource("gmail-main");
  const endpoint = (
    inbox: typeof mainInbox,
    outbox: typeof mainInbox,
    main: boolean,
  ): IpcTransport => ({
    connected: true,
    send(message) {
      const copy = structuredClone(message);
      queueMicrotask(() => {
        const deliver = () => {
          for (const listener of outbox) listener(copy);
        };
        if (main) mainContext.runInAsyncScope(deliver);
        else deliver();
      });
    },
    onMessage(listener) {
      inbox.add(listener);
      return () => {
        inbox.delete(listener);
      };
    },
    onDisconnect: () => () => {},
  });
  const main = new IpcRpc(endpoint(mainInbox, workerInbox, false), "main");
  const worker = new IpcRpc(endpoint(workerInbox, mainInbox, true), "worker");
  server.register(main);
  cleanup.push(() => {
    main.dispose();
    worker.dispose();
    mainContext.emitDestroy();
  });
  return worker;
}

it("uses worker registrations and the real IPC boundary for Gmail reads and approved nested sends", async () => {
  const invoke = rs.fn().mockResolvedValue({ status: 200, data: { id: "message-1" }, headers: {} });
  let connected = true;
  const mainActions = new ActionRegistryImpl();
  registerGmailActions(mainActions, {
    find: () => (connected ? [{ id: "google-1", state: () => "working", act: { invoke } }] : []),
    grantOf: async () => ({
      profile: {
        scopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
        ],
      },
    }),
  } as unknown as ConnectionRegistry);
  const worker = peers(new WorkerRpcServer({} as WorkerRpcServices, gmailWorkerCalls(mainActions)));
  rome = await createTestRome();
  registerGmailActionProxies(rome.actionRegistry, (method, params) =>
    worker.call<unknown, ActionResult>(method, params),
  );
  expect(rome.actionRegistry.get(GMAIL_SEND_ACTION)!.config.requiresApproval).toBe(true);

  const read = { path: "/gmail/v1/users/me/profile" };
  expect(await rome.actionEngine.run(GMAIL_READ_ACTION, read)).toMatchObject({
    status: "ok",
    data: { connectionId: "google-1" },
  });
  connected = false;
  expect(await rome.actionEngine.run(GMAIL_READ_ACTION, read)).toMatchObject({
    status: "error",
    error: expect.stringContaining("gmail_not_connected:"),
  });
  connected = true;
  invoke.mockClear();
  const message = {
    connectionId: "google-1",
    from: "guardian@example.com",
    to: ["friend@example.com"],
    subject: "Approved subject",
    body: "Approved body",
  };
  rome.actionRegistry.register({
    config: {
      name: "test:workflow",
      type: "custom",
      description: "test",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "write",
    },
    execute: () => callAction(GMAIL_SEND_ACTION, message),
  });
  const pending = await rome.actionEngine.run("test:workflow", {}, { initiator: "routine:test" });
  expect(pending.status).toBe("pending_approval");
  expect(invoke).not.toHaveBeenCalled();
  if (pending.status !== "pending_approval") throw new Error("Expected approval");
  await rome.repos.approvals.resolvePending(pending.approval.approvalId, "approve", "guardian");
  await rome.approvalHandler.onApproved(pending.approval.approvalId);
  await rome.approvalHandler.onApproved(pending.approval.approvalId);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith({ operation: "send", input: message });

  // A bare worker RPC is not a native action body, and cannot send mail.
  expect(
    await worker.call("gmail.execute", { name: GMAIL_SEND_ACTION, args: message }),
  ).toMatchObject({ status: "error" });
  expect(invoke).toHaveBeenCalledTimes(1);
});
