import { describe, expect, it, rs } from "@rstest/core";
import { loadLanding, startWelcomeRun } from "./landing.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function state(progress: Record<string, unknown>) {
  return () => Promise.resolve(json({ agentName: "Nova", progress }));
}

const partway = { node: "await_ai", aiConnected: null, sessionId: "chat-1" };

describe("loadLanding", () => {
  it("shows an error, not a first run, when the state read fails", async () => {
    const fetchHost = rs.fn();

    const failed = await loadLanding(() => Promise.resolve(json({}, 500)), fetchHost);
    const thrown = await loadLanding(() => Promise.reject(new Error("offline")), fetchHost);

    expect(failed.landing).toEqual({ kind: "error" });
    expect(thrown.landing).toEqual({ kind: "error" });
    expect(fetchHost).not.toHaveBeenCalled();
  });

  it("shows an error when the state has no readable progress", async () => {
    const result = await loadLanding(() => Promise.resolve(json({ agentName: "Nova" })), rs.fn());

    expect(result.landing).toEqual({ kind: "error" });
  });

  it("shows an error for a node it does not know, inherited object keys included", async () => {
    for (const node of ["await_something_new", "toString", "constructor"]) {
      const result = await loadLanding(
        state({ node, aiConnected: null, sessionId: null }),
        rs.fn(),
      );

      expect(result.landing).toEqual({ kind: "error" });
    }
  });

  it("shows a first run only for a run at greet", async () => {
    const result = await loadLanding(
      state({ node: "greet", aiConnected: null, sessionId: null }),
      rs.fn(),
    );

    expect(result).toEqual({ agentName: "Nova", landing: { kind: "fresh" } });
  });

  it("treats only a 404 as a deleted chat", async () => {
    const gone = await loadLanding(state(partway), () => Promise.resolve(json({}, 404)));

    expect(gone.landing).toMatchObject({ kind: "resume", stepIndex: 1, chatId: null });
  });

  it("keeps the recorded chat when its lookup fails for another reason", async () => {
    const serverError = await loadLanding(state(partway), () => Promise.resolve(json({}, 500)));
    const network = await loadLanding(state(partway), () => Promise.reject(new Error("offline")));

    expect(serverError.landing).toMatchObject({ kind: "resume", chatId: "chat-1" });
    expect(network.landing).toMatchObject({ kind: "resume", chatId: "chat-1" });
  });

  it("picks the newest welcome chat for an older run, archived chats included", async () => {
    const fetchHost = rs.fn(async () =>
      json([
        {
          id: "older",
          agentName: "welcome-to-rome:welcome-to-rome",
          createdAt: "2026-10-01T00:00:00Z",
        },
        {
          id: "archived-newest",
          agentName: "welcome-to-rome:welcome-to-rome",
          createdAt: "2026-10-05T00:00:00Z",
        },
        { id: "other", agentName: null, createdAt: "2026-10-09T00:00:00Z" },
      ]),
    );

    const saveChat = rs.fn(async () => undefined);

    const result = await loadLanding(
      state({ node: "done", aiConnected: false, sessionId: null }),
      fetchHost,
      saveChat,
    );

    expect(fetchHost).toHaveBeenCalledWith("/api/chat/sessions?status=all", expect.anything());
    expect(saveChat).toHaveBeenCalledWith("archived-newest");
    expect(result.landing).toEqual({ kind: "done", chatId: "archived-newest", aiConnected: false });
  });

  it("still shows the found chat when saving it fails", async () => {
    const result = await loadLanding(
      state({ node: "await_names", aiConnected: null, sessionId: null }),
      async () =>
        json([{ id: "c1", agentName: "welcome-to-rome", createdAt: "2026-10-01T00:00:00Z" }]),
      () => Promise.reject(new Error("offline")),
    );

    expect(result.landing).toMatchObject({ kind: "resume", chatId: "c1" });
  });

  it("shows an error when an older run's chat list cannot be read", async () => {
    const result = await loadLanding(
      state({ node: "await_names", aiConnected: null, sessionId: null }),
      () => Promise.resolve(json({}, 503)),
    );

    expect(result.landing).toEqual({ kind: "error" });
  });
});

describe("startWelcomeRun", () => {
  it("opens no chat when a run under way could not be reset", async () => {
    for (const reset of [
      () => Promise.resolve(json({}, 500)),
      () => Promise.reject(new Error("offline")),
    ]) {
      const openChat = rs.fn(async () => {});

      const outcome = await startWelcomeRun({ runUnderWay: true, reset, openChat });

      expect(outcome).toBe("reset_failed");
      expect(openChat).not.toHaveBeenCalled();
    }
  });

  it("still opens the chat for a run not yet started when the reset fails", async () => {
    const openChat = rs.fn(async () => {});

    const outcome = await startWelcomeRun({
      runUnderWay: false,
      reset: () => Promise.resolve(json({}, 500)),
      openChat,
    });

    expect(outcome).toBe("started");
    expect(openChat).toHaveBeenCalledOnce();
  });

  it("reports a chat that failed to open after the reset", async () => {
    const outcome = await startWelcomeRun({
      runUnderWay: true,
      reset: () => Promise.resolve(json({ ok: true })),
      openChat: () => Promise.reject(new Error("no session")),
    });

    expect(outcome).toBe("start_failed");
  });
});
