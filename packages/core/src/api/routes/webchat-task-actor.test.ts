import { describe, expect, it, rs } from "@rstest/core";
import type { ApiDeps } from "../deps.js";
import { createWebchatRuntime } from "./webchat.js";
import { runWithSessionActor, type SessionActor } from "../../access/session-actor.js";
import { claimTaskInputActor, withTaskInputActor } from "../../webchat/task-input-actor.js";

const guardian: SessionActor = { kind: "guardian", userId: "synthetic-seat", via: "cookie" };
const visitor: SessionActor = { kind: "visitor", accountId: "v", email: "v@example.invalid" };
const speaker = { platform: "webchat", id: "core:concierge" };
const body = { text: "inspect metadata, not a data request" };

function harness(owner = "guardian", audience: "private" | "shared" = "private") {
  let active = true;
  const inputs = new Map<string, unknown>();
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
  const updateUserInput = rs.fn(async () => {});
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
    recordUserInput: rs.fn(async (id: string, _chat: string, _content: string, actor: unknown) => {
      inputs.set(id, actor);
      return true;
    }),
    getUserInput: async (_chat: string, id: string) =>
      inputs.has(id) ? { inputState: "queued" } : null,
    updateUserInput,
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
    repo,
    submit,
    release,
    open,
    updateUserInput,
    revoke: () => {
      active = false;
    },
    send: (actor = guardian) =>
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
        body,
        () => built.runtime.post("target", body, speaker),
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
