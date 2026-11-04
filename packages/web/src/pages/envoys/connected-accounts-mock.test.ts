/**
 * Mock mode has to show what core does when a linked bot is disconnected: its
 * connected account stays with its agent, Envoys lists it as disconnected, and
 * it can be unlinked by its account. Driven through the mock's own handlers.
 */
// @rstest-environment jsdom
import { afterAll, beforeAll, expect, test } from "@rstest/core";
import { setupServer } from "msw/node";
import { handlers } from "../../../mock/handlers";
import {
  fetchConnectedAccounts,
  fetchConnections,
  revokeConnectionGrant,
  unlinkConnectedAccount,
} from "@/lib/connections-api";

const server = setupServer(...handlers);

beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterAll(() => server.close());

test("a disconnected bot keeps its agent and name, and can be unlinked", async () => {
  const telegram = (await fetchConnections()).find((c) => c.id === "telegram-1")!;
  expect(telegram.account).toEqual({ platform: "telegram", id: "7000000001" });

  expect((await revokeConnectionGrant("telegram-1", "bot")).ok).toBe(true);

  const kept = (await fetchConnectedAccounts()).find((a) => a.account.id === "7000000001");
  expect(kept).toMatchObject({ name: "Rome", connection: null });
  expect(kept?.agent).not.toBeNull();

  await unlinkConnectedAccount(kept!.account, "failed");
  const after = (await fetchConnectedAccounts()).find((a) => a.account.id === "7000000001");
  expect(after?.agent).toBeNull();
});
