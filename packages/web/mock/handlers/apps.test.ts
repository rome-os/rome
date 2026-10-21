/**
 * The mock's PATCH /api/apps/:appId answers the system app the way core's
 * route does: every PATCH is refused before the body is read, with the
 * route's own message and status.
 */
// @rstest-environment jsdom
import { afterAll, beforeAll, expect, test } from "@rstest/core";
import { setupServer } from "msw/node";
import { appHandlers } from "./apps";

// MSW resolves relative request handlers against the jsdom document origin,
// which rstest serves on port 3000; the path under test is what matters.
const BASE = "http://localhost:3000";

const server = setupServer(...appHandlers);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());

function patch(appId: string, body: unknown) {
  return fetch(`${BASE}/api/apps/${appId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test.each([false, true])("refuses PATCH { enabled: %s } to the system app", async (enabled) => {
  const res = await patch("system", { enabled });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: 'SYSTEM_PROTECTED: App "system" cannot be modified' });
});

test("disables another first-party app", async () => {
  const res = await patch("recap", { enabled: false });
  expect(res.status).toBe(200);
  expect((await res.json()).spec.enabled).toBe(false);
});
