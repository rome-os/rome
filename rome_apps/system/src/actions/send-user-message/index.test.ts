import { describe, expect, it, rs } from "@rstest/core";
import type { ActionConfig } from "@rome-os/app-runtime";
import { createSendUserMessageAction } from "./index.js";

const config = { name: "send_user_message" } as unknown as ActionConfig;
const BASE = "http://127.0.0.1:4141";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(...responses: Response[]) {
  const impl = rs.fn<typeof fetch>();
  for (const res of responses) impl.mockResolvedValueOnce(res);
  return impl;
}

function requestBody(impl: ReturnType<typeof rs.fn>, call: number): Record<string, unknown> {
  const init = impl.mock.calls[call][1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe("send_user_message", () => {
  it("defaults to creating a new chat, then posts the text as a guardian turn", async () => {
    const fetchImpl = makeFetch(
      jsonResponse(200, { id: "sess-1" }),
      jsonResponse(200, { turnId: "turn-1", sessionId: "sess-1" }),
    );
    const action = createSendUserMessageAction(config, { fetchImpl, baseUrl: BASE });

    const result = await action.execute({ text: "Summarize my inbox" });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/api/chat/sessions`);
    // No explicit agentName ⇒ the route's own default (main) applies.
    expect(requestBody(fetchImpl, 0)).toEqual({});
    expect(fetchImpl.mock.calls[1][0]).toBe(`${BASE}/api/chat/sessions/sess-1/turns`);
    expect(requestBody(fetchImpl, 1)).toEqual({ text: "Summarize my inbox" });
    expect(result).toEqual({
      status: "ok",
      data: { sessionId: "sess-1", turnId: "turn-1", createdSession: true },
    });
  });

  it("continues an existing session without creating one", async () => {
    const fetchImpl = makeFetch(jsonResponse(200, { turnId: "turn-2", sessionId: "sess-9" }));
    const action = createSendUserMessageAction(config, { fetchImpl, baseUrl: BASE });

    const result = await action.execute({ text: "any update?", sessionId: "sess-9" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(`${BASE}/api/chat/sessions/sess-9/turns`);
    expect(result).toEqual({
      status: "ok",
      data: { sessionId: "sess-9", turnId: "turn-2", createdSession: false },
    });
  });

  it("passes agentName and projectPath to creation, then applies sessionName after the turn", async () => {
    const fetchImpl = makeFetch(
      jsonResponse(200, { id: "sess-2" }),
      jsonResponse(200, { turnId: "turn-3" }),
      jsonResponse(200, { id: "sess-2", name: "Weekly planning" }),
    );
    const action = createSendUserMessageAction(config, { fetchImpl, baseUrl: BASE });

    const result = await action.execute({
      text: "plan the week",
      agentName: "envoy",
      sessionName: "Weekly planning",
      projectPath: "planning",
    });

    expect(requestBody(fetchImpl, 0)).toEqual({ agentName: "envoy", projectPath: "planning" });
    // The rename runs AFTER the turn — the first turn auto-names a fresh
    // session from the message text, so naming before it would be clobbered.
    expect(fetchImpl.mock.calls[2][0]).toBe(`${BASE}/api/chat/sessions/sess-2/name`);
    expect((fetchImpl.mock.calls[2][1] as RequestInit).method).toBe("PATCH");
    expect(requestBody(fetchImpl, 2)).toEqual({ name: "Weekly planning" });
    expect(result.status).toBe("ok");
  });

  it("treats a rename failure as a warning, not an action error", async () => {
    const fetchImpl = makeFetch(
      jsonResponse(200, { id: "sess-5" }),
      jsonResponse(200, { turnId: "turn-5" }),
      jsonResponse(500, { error: "boom" }),
    );
    const action = createSendUserMessageAction(config, { fetchImpl, baseUrl: BASE });

    const result = await action.execute({ text: "hello", sessionName: "Named chat" });

    expect(result).toEqual({
      status: "ok",
      data: { sessionId: "sess-5", turnId: "turn-5", createdSession: true },
    });
  });

  it("surfaces the route error when session creation fails and sends no turn", async () => {
    const fetchImpl = makeFetch(jsonResponse(400, { error: 'Agent "nope" not found' }));
    const action = createSendUserMessageAction(config, { fetchImpl, baseUrl: BASE });

    const result = await action.execute({ text: "hi", agentName: "nope" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("error");
    expect(result).toMatchObject({ error: expect.stringContaining('Agent "nope" not found') });
  });

  it("names the created session when the turn fails after creation", async () => {
    const fetchImpl = makeFetch(
      jsonResponse(200, { id: "sess-3" }),
      jsonResponse(409, { error: "This chat is archived and read-only" }),
    );
    const action = createSendUserMessageAction(config, { fetchImpl, baseUrl: BASE });

    const result = await action.execute({ text: "hello" });

    expect(result.status).toBe("error");
    expect(result).toMatchObject({ error: expect.stringContaining("sess-3") });
    expect(result).toMatchObject({ error: expect.stringContaining("archived") });
  });

  it("rejects empty text at the schema boundary without any HTTP call", async () => {
    const fetchImpl = makeFetch();
    const action = createSendUserMessageAction(config, { fetchImpl, baseUrl: BASE });

    const result = await action.execute({ text: "" });

    expect(result.status).toBe("error");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("previews the verbatim text and target, keeping session ids out of the card", async () => {
    const action = createSendUserMessageAction(config, { fetchImpl: makeFetch(), baseUrl: BASE });

    const newChat = action.preview?.({ text: "Morning briefing please" });
    expect(newChat).toMatchObject({
      title: "Start a webchat conversation as the guardian",
      summary: "Morning briefing please",
      fields: [{ label: "Agent", value: "main" }],
    });

    const existing = action.preview?.({ text: "and then?", sessionId: "sess-4" });
    expect(existing).toMatchObject({
      title: "Continue a webchat conversation as the guardian",
      summary: "and then?",
    });
    expect(JSON.stringify(existing)).not.toContain("sess-4");
  });
});
