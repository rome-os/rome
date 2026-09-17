/**
 * The drill-through mock mode has to answer: a row on `/sessions/all` links to
 * `/sessions/:id`, and that page reads `/api/sessions/:id` and
 * `/api/sessions/:id/messages`. Those are a different namespace from the
 * `/api/chat/sessions/*` routes the chat surface uses, so the query handler
 * alone leaves every row opening a proxy error with no backend.
 *
 * `onUnhandledRequest: "error"` is what pins that: an unmocked route fails here
 * rather than falling through to the dev proxy the way it does in the browser.
 */
// @rstest-environment jsdom
import { afterAll, beforeAll, expect, test } from "@rstest/core";
import { setupServer } from "msw/node";
import type { RomeSessionDetail, RomeSessionsPageResult } from "@rome/api-types/sessions";
import type { ChatMessage } from "@/lib/chat-types";
import { sessionQueryHandlers } from "../../mock/handlers/sessions";

const CHAT = {
  id: "chat-leak",
  name: "Leak follow-up with Dana",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} as never;

const TRANSCRIPT = [
  { id: "m1", role: "user", content: "Did the plumber call back?" },
  { id: "m2", role: "assistant", content: "Not yet — I will chase them." },
] as unknown as ChatMessage[];

const server = setupServer(...sessionQueryHandlers([CHAT], { "chat-leak": TRANSCRIPT }));
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

const BASE = "http://localhost:3000";

test("every listed row can be opened", async () => {
  const listed = (await (
    await fetch(`${BASE}/api/sessions/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: { time: { kind: "preset", value: "30d" } },
        sort: { field: "activity", direction: "desc" },
        page: { offset: 0, limit: 50 },
      }),
    })
  ).json()) as RomeSessionsPageResult;

  expect(listed.sessions.length).toBeGreaterThan(0);

  for (const row of listed.sessions) {
    const detailRes = await fetch(`${BASE}/api/sessions/${encodeURIComponent(row.id)}`);
    expect(detailRes.status, `${row.id} detail`).toBe(200);
    const detail = (await detailRes.json()) as RomeSessionDetail;
    expect(detail.id).toBe(row.id);
    expect(detail.lineage).toBeTruthy();

    const messagesRes = await fetch(`${BASE}/api/sessions/${encodeURIComponent(row.id)}/messages`);
    expect(messagesRes.status, `${row.id} messages`).toBe(200);
    expect(Array.isArray(await messagesRes.json())).toBe(true);
  }
});

test("a seeded chat serves its own transcript, and an unknown id is a 404", async () => {
  const messages = (await (
    await fetch(`${BASE}/api/sessions/chat-leak/messages`)
  ).json()) as ChatMessage[];
  expect(messages).toHaveLength(2);

  expect((await fetch(`${BASE}/api/sessions/nope/messages`)).status).toBe(404);
  expect((await fetch(`${BASE}/api/sessions/nope`)).status).toBe(404);
});
