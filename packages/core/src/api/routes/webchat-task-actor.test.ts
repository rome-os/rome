import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import {
  ComputerRequestVerifier,
  signedComputerRequest,
  type ComputerAuthorization,
} from "@rome-os/node-core/computer-origin";
import { describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { COOKIE_NAME, createSession } from "../../access/auth.js";
import { sessionActorMiddleware } from "../../access/session-actor.js";
import { browserChatInput, type TurnActor, type TurnFacts } from "../../agent/index.js";
import { computerUseTool } from "../../core/computer-use-tool.js";
import { createTestDb } from "../../test/db.js";
import type { InputStatusEvent } from "@rome-os/app-runtime";
import type { ApiDeps } from "../deps.js";
import { createWebchatRuntime } from "./webchat.js";
import { runWithSessionActor, type SessionActor } from "../../access/session-actor.js";
import { claimTaskInputActor, withTaskInputActor } from "../../webchat/task-input-actor.js";

const guardian: SessionActor = { kind: "guardian", userId: "synthetic-seat", via: "cookie" };
const visitor: SessionActor = { kind: "visitor", accountId: "v", email: "v@example.invalid" };
const speaker = { platform: "webchat", id: "core:concierge" };
const body = { text: "inspect metadata, not a data request" };

async function sendOnLoopback(app: Hono, init: RequestInit) {
  const server = createServer(getRequestListener(app.fetch));
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/chat/sessions/target/turns`, init);
    await response.arrayBuffer();
    return response.status;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it("admits Computer Use from the browser's private chat and refuses native and unsigned inputs on the same route", async () => {
  const db = createTestDb();
  const peer = randomUUID();
  const device = randomUUID();
  const { privateKey: key, publicKey } = generateKeyPairSync("ed25519");
  const verifier = new ComputerRequestVerifier(device, peer, publicKey);
  try {
    for (const [entry, forwarded, sameOrigin, expected] of [
      ["cloud-browser", false, true, "local"],
      ["cloud-browser", true, true, "instance"],
      ["local-password", false, true, "local-password"],
      ["local-password", true, true, undefined],
      ["cloud-browser", false, false, undefined],
      [undefined, false, true, undefined],
      [undefined, true, true, undefined],
    ] as const) {
      const s = harness();
      const app = new Hono();
      app.use("*", sessionActorMiddleware(db.db));
      app.route("/api", s.routes);
      const status = await sendOnLoopback(app, {
        method: "POST",
        headers: {
          cookie: COOKIE_NAME + "=" + createSession("seat", entry),
          "sec-fetch-site": sameOrigin ? "same-origin" : "cross-site",
          ...(forwarded && { "x-forwarded-for": "192.0.2.1" }),
          "content-type": "application/json",
          "x-rome-device-id": "claimed-desktop",
        },
        body: JSON.stringify({
          text: "Read browser status",
          priority: "next",
          entry: "cloud-browser",
          browserChatInput: true,
        }),
      });
      expect(status).toBe(200);
      const admitted = s.submit.mock.calls[0]?.[1] as { actor: TurnActor };
      expect(admitted.actor[browserChatInput]).toBe(expected);
      const localStatus = rs.fn(async () => ({ daemon: "running" }));
      const run = rs.fn(
        async (target: string, action: string, args: unknown, proof?: ComputerAuthorization) => {
          expect(target).toBe(device);
          if (action === "system.info")
            return {
              ok: true as const,
              result: {
                actions: ["computer.status"],
                audit: { state: "ok" },
                computerUsePilot: { epoch: verifier.epoch, signedRequest: signedComputerRequest },
              },
            };
          expect(
            proof &&
              verifier.consume(
                { peer, requestId: proof.requestId, action, args },
                proof.authorization,
              ),
          ).toBe(true);
          return { ok: true as const, result: {} };
        },
      );
      const tool = computerUseTool(
        {
          grants: {
            local: true,
            instance: { peer, key, targets: { [device]: ["computer.status"] } },
          },
          localStatus,
          run,
        },
        {
          turnId: () => "turn",
          threadContext: () => ({ channel: "webchat", threadId: "target" }),
          live: () => true,
          audience: () => "private",
          actor: () => admitted.actor,
        } as TurnFacts,
        true,
        async () => true,
      );
      const local = expected === "local" || expected === "local-password";
      const remote = expected === "local" || expected === "instance";
      for (let i = 0; i < 2; i++) {
        const result = await tool.handler({ target: "local", operation: "computer.status" });
        expect(result.isError === true).toBe(!local);
        const forwarded = await tool.handler({ target: device, operation: "computer.status" });
        expect(forwarded.isError === true).toBe(!remote);
      }
      expect(localStatus).toHaveBeenCalledTimes(local ? 2 : 0);
      expect(run).toHaveBeenCalledTimes(remote ? 4 : 0);
    }
  } finally {
    db.close();
  }
});

function harness(owner = "guardian", audience: "private" | "shared" = "private") {
  let active = true;
  const inputs = new Map<string, { inputState: InputStatusEvent["state"]; turnId?: string }>();
  const rows = new Map([
    [
      "source",
      {
        id: "source",
        name: "Concierge",
        type: "webchat",
        agentName: "core:concierge",
        ownerKey: owner,
        archivedAt: null,
        parentSessionId: null,
      },
    ],
    [
      "target",
      {
        id: "target",
        name: "Task",
        type: "webchat",
        agentName: "core:main",
        triggerKind: "concierge",
        ownerKey: owner,
        archivedAt: null,
        parentSessionId: null,
      },
    ],
  ]);
  // Keep the fake receipt queued so this boundary test never runs a model or an output drain.
  const submit = rs.fn((_input: unknown, _options: unknown) => ({
    turnId: "task-turn",
    landed: "queued",
    turn: new Promise(() => {}),
  }));
  const release = rs.fn();
  const session = {
    sessionId: "agent-session",
    key: { agentName: "core:main", channelThreadKey: "webchat:target" },
    submit,
    release,
  };
  const open = rs.fn(async () => session);
  const updateUserInput = rs.fn(async (_chat: string, status: InputStatusEvent) => {
    if (inputs.has(status.inputId)) {
      inputs.set(status.inputId, {
        inputState: status.state,
        ...(status.turnId ? { turnId: status.turnId } : {}),
      });
    }
  });
  const failQueuedUserInput = rs.fn(async (_chat: string, inputId: string) => {
    if (inputs.get(inputId)?.inputState === "queued") {
      inputs.set(inputId, { ...inputs.get(inputId)!, inputState: "failed" });
    }
  });
  const repo = {
    onMessageInserted: () => () => {},
    getSession: async (id: string) => rows.get(id) ?? null,
    askingDeviceOf: rs.fn(async (_id: string): Promise<string | null> => null),
    getMessages: async () => [],
    getMessageCount: async () => 1,
    getProjectRecordByPath: async () => ({
      id: "default",
      name: "default",
      path: "default",
      archivedAt: null,
    }),
    recordSessionInChat: async () => null,
    recordUserInput: rs.fn(async (id: string, _chat: string, _content: string, _actor: unknown) => {
      inputs.set(id, { inputState: "queued" });
      return true;
    }),
    getUserInput: async (_chat: string, id: string) => inputs.get(id) ?? null,
    updateUserInput,
    failQueuedUserInput,
  };
  const agent = {
    name: "core:concierge",
    localName: "concierge",
    ownerType: "core",
    ownerId: "core",
    definition: {
      policy: {},
      systemPromptPrefix: "",
      tools: [],
      actions: [],
      permissionMode: "default",
    },
  };
  const deps = {
    webchatRepo: repo,
    appCatalog: { get: () => undefined },
    agentLoader: { find: () => agent, list: () => [agent] },
    agentTurnStreamRegistry: { onSessionChange: () => () => {}, listBySession: () => [] },
    agentSessionManager: { open },
    skillCatalog: { find: () => undefined, list: () => [] },
    settingsRepo: { get: async () => undefined },
    peopleRepo: { byBondLevel: async () => [] },
    sessionOpeningFor: () => ({}),
    concierge: {
      deps: {
        tasks: {
          repo: {
            findBySession: async () => ({ id: "task" }),
            getWithChat: async () => ({ conciergeChat: { id: "source" } }),
          },
        },
      },
    },
  } as unknown as ApiDeps;
  const built = createWebchatRuntime(deps);
  return {
    ...built,
    rows,
    inputs,
    repo,
    submit,
    release,
    open,
    updateUserInput,
    failQueuedUserInput,
    revoke: () => {
      active = false;
    },
    send: (actor = guardian, sentBody = body) =>
      withTaskInputActor(
        {
          agentName: "core:concierge",
          chatId: "source",
          turnId: "source-turn",
          actor,
          audience,
          isCurrent: () => active,
        },
        "target",
        sentBody,
        () => built.runtime.post("target", sentBody, speaker),
      ),
  };
}

describe("webchat task actor admission without a database or provider", () => {
  it("hands the verified guardian through the actual post route to submit", async () => {
    const s = harness();
    expect(await s.send()).toMatchObject({ ok: true });
    expect(s.submit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actor: guardian }),
    );
    expect(s.repo.recordUserInput).toHaveBeenCalledWith(
      expect.anything(),
      "target",
      expect.anything(),
      guardian,
      speaker,
      undefined,
    );
  });

  for (const [audience, actor, owner] of [
    ["private", guardian, "guardian"],
    ["shared", visitor, "visitor:v"],
  ] as const) {
    it(`keeps the ${audience} ${actor.kind} source audience as the task's parent boundary`, async () => {
      const s = harness(owner, audience);
      expect(await s.send(actor)).toMatchObject({ ok: true });
      expect(s.submit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ actor, parentAudience: audience }),
      );
    });
  }

  it("refuses a guardian handoff from a shared source audience", async () => {
    const s = harness("guardian", "shared");
    await expect(s.send()).rejects.toThrow("Task input attribution is unavailable");
    expect(s.submit).not.toHaveBeenCalled();
  });

  it("keeps the task's asking device while admitting its verified actor", async () => {
    const s = harness();
    s.repo.askingDeviceOf.mockResolvedValue("synthetic-device");
    expect(await s.send()).toMatchObject({ ok: true });
    expect(s.submit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actor: guardian,
        parentAudience: "private",
        threadContext: expect.objectContaining({ askingDeviceId: "synthetic-device" }),
      }),
    );
  });

  it("preserves a visitor through the route, even with an unrelated guardian ambient scope", async () => {
    const s = harness("visitor:v");
    expect(await runWithSessionActor(guardian, () => s.send(visitor))).toMatchObject({ ok: true });
    expect(s.submit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actor: visitor }),
    );
  });

  it("does not use model-supplied actor or taskActor fields without a handoff", async () => {
    const s = harness();
    expect(
      await s.runtime.post(
        "target",
        { ...body, actor: guardian, taskActor: guardian } as typeof body,
        speaker,
      ),
    ).toMatchObject({ ok: true });
    expect(s.submit.mock.calls[0]![1]).not.toHaveProperty("actor");
  });

  it("reports a refused admission after Stop rather than claiming delivery", async () => {
    const s = harness();
    s.open.mockImplementation(async () => {
      s.revoke();
      return {
        sessionId: "agent-session",
        key: { agentName: "core:main", channelThreadKey: "webchat:target" },
        submit: s.submit,
        release: s.release,
      };
    });
    expect(await s.send()).toMatchObject({ ok: false });
    expect(s.submit).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledTimes(1);
    expect(s.updateUserInput).toHaveBeenCalledWith(
      "target",
      expect.objectContaining({ state: "failed" }),
    );
  });

  it("reports lease expiry during a cold open without submitting or claiming success", async () => {
    const s = harness();
    const now = Date.now();
    const clock = rs.spyOn(Date, "now").mockReturnValue(now);
    s.open.mockImplementation(async () => {
      clock.mockReturnValue(now + 30_001);
      return {
        sessionId: "agent-session",
        key: { agentName: "core:main", channelThreadKey: "webchat:target" },
        submit: s.submit,
        release: s.release,
      };
    });
    try {
      expect(await s.send()).toMatchObject({ ok: false });
      expect(s.submit).not.toHaveBeenCalled();
      expect(s.release).toHaveBeenCalledTimes(1);
      expect(s.updateUserInput).toHaveBeenCalledWith(
        "target",
        expect.objectContaining({ state: "failed" }),
      );
    } finally {
      clock.mockRestore();
    }
  });

  for (const change of ["owner", "archive"] as const) {
    it(`rechecks ${change} after the model session opens`, async () => {
      const s = harness();
      s.open.mockImplementation(async () => {
        const row = s.rows.get("target")!;
        if (change === "owner") row.ownerKey = "visitor:other";
        else Object.assign(row, { archivedAt: new Date() });
        return {
          sessionId: "agent-session",
          key: { agentName: "core:main", channelThreadKey: "webchat:target" },
          submit: s.submit,
          release: s.release,
        };
      });
      expect(await s.send()).toMatchObject({ ok: false });
      expect(s.submit).not.toHaveBeenCalled();
      expect(s.updateUserInput).toHaveBeenCalledWith(
        "target",
        expect.objectContaining({ state: "failed" }),
      );
    });
  }

  it("marks a recorded attributed input failed after a generic open error, without resending", async () => {
    const s = harness();
    s.open.mockRejectedValue(new Error("synthetic setup failure"));
    expect(await s.send()).toMatchObject({ ok: false });
    expect([...s.inputs.values()]).toEqual([{ inputState: "failed" }]);
    expect(s.failQueuedUserInput).toHaveBeenCalledTimes(1);
    expect(s.updateUserInput).not.toHaveBeenCalled();
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.repo.recordUserInput).toHaveBeenCalledTimes(1);
    expect(s.submit).not.toHaveBeenCalled();
  });

  it("preserves ordinary unattributed delivery's recorded state on the same open error", async () => {
    const s = harness();
    s.open.mockRejectedValue(new Error("synthetic setup failure"));
    expect(await s.runtime.post("target", body, speaker)).toMatchObject({ ok: true });
    expect([...s.inputs.values()]).toEqual([{ inputState: "queued" }]);
    expect(s.updateUserInput).not.toHaveBeenCalled();
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.submit).not.toHaveBeenCalled();
  });

  it("does not invent a failed record for a refusal before input recording", async () => {
    const s = harness();
    expect(await s.send(guardian, { text: " " })).toMatchObject({ ok: false });
    expect(s.inputs.size).toBe(0);
    expect(s.updateUserInput).not.toHaveBeenCalled();
    expect(s.open).not.toHaveBeenCalled();
    expect(s.submit).not.toHaveBeenCalled();
  });

  for (const state of ["submitted", "accepted", "consumed", "unknown", "failed"] as const) {
    it(`does not overwrite a recorded ${state} input on an open error`, async () => {
      const s = harness();
      s.open.mockImplementation(async () => {
        const id = [...s.inputs.keys()][0]!;
        s.inputs.set(id, { inputState: state, turnId: "existing-turn" });
        throw new Error("synthetic setup failure");
      });
      expect(await s.send()).toMatchObject({ ok: false });
      expect([...s.inputs.values()]).toEqual([{ inputState: state, turnId: "existing-turn" }]);
      expect(s.updateUserInput).not.toHaveBeenCalled();
      expect(s.open).toHaveBeenCalledTimes(1);
      expect(s.submit).not.toHaveBeenCalled();
    });
  }

  it("opens the receiving model outside the spent handoff's async scope", async () => {
    const s = harness();
    s.open.mockImplementation(async () => {
      expect(claimTaskInputActor("target", body, speaker)).toBeUndefined();
      return {
        sessionId: "agent-session",
        key: { agentName: "core:main", channelThreadKey: "webchat:target" },
        submit: s.submit,
        release: s.release,
      };
    });
    expect(await s.send()).toMatchObject({ ok: true });
    expect(s.submit).toHaveBeenCalledTimes(1);
  });

  it("keeps direct guardian admission unchanged", async () => {
    const s = harness();
    const response = await runWithSessionActor(guardian, () =>
      s.routes.request("/chat/sessions/target/turns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(200);
    expect(s.submit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ actor: guardian }),
    );
  });

  it("refuses a forged actor in an external HTTP body", async () => {
    const s = harness();
    const response = await s.routes.request("/chat/sessions/target/turns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, actor: guardian, taskActor: guardian }),
    });
    expect(response.status).toBe(200);
    expect(s.submit.mock.calls[0]![1]).not.toHaveProperty("actor");
  });
});
