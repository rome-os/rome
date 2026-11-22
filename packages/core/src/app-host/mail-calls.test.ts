import { actionExecutionContext } from "../apps/actions/context.js";
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
import {
  OUTLOOK_READ_ACTION,
  OUTLOOK_SEND_ACTION,
  registerOutlookActions,
} from "../connections/outlook/actions.js";
import type { ConnectionRegistry } from "../connections/registry.js";
import { createTestRome, type TestRome } from "../test/kit/index.js";
import { mailWorkerCalls, registerMailActionProxies } from "./mail-calls.js";

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

async function setup() {
  const invoke = rs.fn().mockResolvedValue({ status: 200, data: { id: "message-1" }, headers: {} });
  let connected = true;
  const mainActions = new ActionRegistryImpl();
  registerGmailActions(
    mainActions,
    {
      find: () => (connected ? [{ id: "google-1", state: () => "working", act: { invoke } }] : []),
      grantOf: async () => ({
        profile: {
          scopes: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
          ],
        },
      }),
    } as unknown as ConnectionRegistry,
    {
      claimApprovedSend: (id, argsHash) =>
        rome.repos.approvals.claimApprovedEffect(id, GMAIL_SEND_ACTION, argsHash),
    },
  );
  registerOutlookActions(
    mainActions,
    {
      find: () =>
        connected ? [{ id: "microsoft-1", state: () => "working", act: { invoke } }] : [],
      grantOf: async () => ({ profile: { scopes: ["User.Read", "Mail.Read", "Mail.Send"] } }),
    } as unknown as ConnectionRegistry,
    {
      claimApprovedSend: (id, argsHash) =>
        rome.repos.approvals.claimApprovedEffect(id, OUTLOOK_SEND_ACTION, argsHash),
    },
  );
  const worker = peers(new WorkerRpcServer({} as WorkerRpcServices, mailWorkerCalls(mainActions)));
  rome = await createTestRome();
  registerMailActionProxies(rome.actionRegistry, (method, params) =>
    worker.call<unknown, ActionResult>(method, params),
  );

  return {
    invoke,
    worker,
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
}

it("uses worker registrations and the real IPC boundary for Gmail reads and approved nested sends", async () => {
  const { invoke, worker, setConnected } = await setup();
  expect(rome.actionRegistry.get(GMAIL_SEND_ACTION)!.config.requiresApproval).toBe(true);
  const read = { path: "/gmail/v1/users/me/profile" };
  expect(await rome.actionEngine.run(GMAIL_READ_ACTION, read)).toMatchObject({
    status: "ok",
    data: { connectionId: "google-1" },
  });
  setConnected(false);
  expect(await rome.actionEngine.run(GMAIL_READ_ACTION, read)).toMatchObject({
    status: "error",
    error: expect.stringContaining("gmail_not_connected:"),
  });
  setConnected(true);
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
    await worker.call("mail.execute", { name: GMAIL_SEND_ACTION, args: message }),
  ).toMatchObject({ status: "error" });
  expect(invoke).toHaveBeenCalledTimes(1);
});

const approvedMessage = {
  connectionId: "google-1",
  from: "guardian@example.com",
  to: ["friend@example.com"],
  subject: "Approved",
  body: "Exact approved body",
};
const workflowConfig = {
  name: "test:several_sends",
  type: "custom" as const,
  description: "test",
  complexity: "simple" as const,
  speed: "fast" as const,
  reliability: "high" as const,
  sideEffects: "write" as const,
};

it("approving only B never sends rejected A from the same replay snapshot", async () => {
  const { invoke } = await setup();
  const first = { ...approvedMessage, subject: "Rejected A", to: ["unapproved@example.com"] };
  const second = { ...approvedMessage, subject: "Approved B" };
  rome.actionRegistry.register({
    config: workflowConfig,
    execute: async () => {
      await callAction(GMAIL_SEND_ACTION, first);
      return callAction(GMAIL_SEND_ACTION, second);
    },
  });
  expect(await rome.actionEngine.run(workflowConfig.name, {})).toMatchObject({
    status: "pending_approval",
  });
  const pending = await rome.repos.approvals.list("pending");
  const a = pending.find(
    (row) => (row.payload as { args: typeof first }).args.subject === first.subject,
  )!;
  const b = pending.find(
    (row) => (row.payload as { args: typeof second }).args.subject === second.subject,
  )!;
  await rome.repos.approvals.resolvePending(a.id, "reject", "guardian");
  await rome.repos.approvals.resolvePending(b.id, "approve", "guardian");
  await rome.approvalHandler.onApproved(b.id);
  // Shared replay can re-ask for B after refusing A; it must never send A.
  expect(invoke).not.toHaveBeenCalled();
  const again = (await rome.repos.approvals.list("pending")).find(
    (row) => (row.payload as { args: typeof second }).args.subject === second.subject,
  )!;
  await rome.repos.approvals.resolvePending(again.id, "approve", "guardian");
  await rome.approvalHandler.onApproved(again.id);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith({ operation: "send", input: second });
});

it("one approval sends once when two identical nested calls replay concurrently", async () => {
  const { invoke } = await setup();
  rome.actionRegistry.register({
    config: workflowConfig,
    execute: async () => ({
      status: "ok",
      data: await Promise.all([
        callAction(GMAIL_SEND_ACTION, approvedMessage),
        callAction(GMAIL_SEND_ACTION, approvedMessage),
      ]),
    }),
  });
  expect(await rome.actionEngine.run(workflowConfig.name, {})).toMatchObject({
    status: "pending_approval",
  });
  const pending = await rome.repos.approvals.list("pending");
  expect(pending).toHaveLength(2);
  await rome.repos.approvals.resolvePending(pending[0].id, "approve", "guardian");
  await rome.approvalHandler.onApproved(pending[0].id);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("forging the native IPC caller does not replace an exact, resolved, unused main-side approval", async () => {
  const { invoke, worker } = await setup();
  const id = await rome.repos.approvals.create({
    type: "action_execution",
    requestedBy: "test",
    description: "fake approval",
    payload: { actionName: GMAIL_SEND_ACTION, args: approvedMessage },
  });
  const forged = (approvalId: string, args: Record<string, unknown>) =>
    actionExecutionContext.run(
      {
        actionName: GMAIL_SEND_ACTION,
        executionId: "forged",
        rootExecutionId: "forged",
        initiator: `approval:${approvalId}`,
      },
      () => worker.call("mail.execute", { name: GMAIL_SEND_ACTION, args, approvalId }),
    );
  expect(await forged("missing", approvedMessage)).toMatchObject({ status: "error" });
  expect(await forged(id, approvedMessage)).toMatchObject({ status: "error" });
  await rome.repos.approvals.resolvePending(id, "approve", "guardian");
  expect(await forged(id, approvedMessage)).toMatchObject({ status: "error" });
  await rome.repos.approvals.claimExecution(id);
  expect(await forged(id, { ...approvedMessage, body: "Unapproved replacement" })).toMatchObject({
    status: "error",
  });
  expect(invoke).not.toHaveBeenCalled();
  expect(await forged(id, approvedMessage)).toMatchObject({ status: "ok" });
  expect(await forged(id, approvedMessage)).toMatchObject({ status: "error" });
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("carries Outlook reads and approved sends over the same IPC boundary", async () => {
  const { invoke, worker } = await setup();
  expect(rome.actionRegistry.get(OUTLOOK_SEND_ACTION)!.config.requiresApproval).toBe(true);
  expect(await rome.actionEngine.run(OUTLOOK_READ_ACTION, { path: "/v1.0/me" })).toMatchObject({
    status: "ok",
    data: { connectionId: "microsoft-1" },
  });
  invoke.mockClear();
  const message = { ...approvedMessage, connectionId: "microsoft-1" };
  rome.actionRegistry.register({
    config: workflowConfig,
    execute: () => callAction(OUTLOOK_SEND_ACTION, message),
  });
  const pending = await rome.actionEngine.run(
    workflowConfig.name,
    {},
    { initiator: "routine:test" },
  );
  if (pending.status !== "pending_approval") throw new Error("Expected approval");
  expect(invoke).not.toHaveBeenCalled();
  await rome.repos.approvals.resolvePending(pending.approval.approvalId, "approve", "guardian");
  await rome.approvalHandler.onApproved(pending.approval.approvalId);
  await rome.approvalHandler.onApproved(pending.approval.approvalId);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith({ operation: "send", input: message });
  expect(
    await worker.call("mail.execute", { name: OUTLOOK_SEND_ACTION, args: message }),
  ).toMatchObject({ status: "error" });
  expect(invoke).toHaveBeenCalledTimes(1);
});
