import { describe, expect, it, rs } from "@rstest/core";
import type { AgentTurnFailure } from "@rome-os/app-runtime";
import type { ModelAccountReports, ProviderId } from "../agent/index.js";
import { reportOf } from "../test/kit/model-accounts.js";
import { createProviderFailures, PROVIDER_OUTAGES_SETTING_KEY } from "./provider-failures.js";

type Row = {
  largeModelSelection?: string | null;
  largeModelSelectionBy?: "owner" | "auto" | null;
  triggerKind?: string | null;
  agentName?: string | null;
};

function harness(chats: Record<string, Row>, reports: ModelAccountReports) {
  const messages: Array<{ chatId: string; parts: unknown[]; id: string }> = [];
  const updates: Array<{ id: string; content: string }> = [];
  const settings = new Map<string, unknown>();
  const runs: Array<{ threadId: string; providerOverride?: string }> = [];
  const pushes: string[] = [];
  const listeners = new Set<
    (provider: ProviderId, change: "authorization" | "refreshed") => void
  >();
  const failures = createProviderFailures({
    accounts: {
      read: () => reports,
      onChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    defaults: {
      current: () => "anthropic",
      signedIn: () => ({ anthropic: true, openai: true, rome_credits: false }),
    },
    webchatRepo: {
      getSession: async (id: string) => (chats[id] ? { id, ...chats[id] } : null),
      addBackendMessage: async (chatId: string, _turnId: string, parts: unknown[]) => {
        const id = `m${messages.length}`;
        messages.push({ chatId, parts, id });
        return { id };
      },
      updateMessageContent: async (id: string, content: string) => {
        updates.push({ id, content });
      },
    } as never,
    settings: {
      get: async (key: string) => (settings.get(key) ?? null) as never,
      set: async (key: string, value: unknown) => {
        settings.set(key, value);
      },
    },
    mainChatId: async () => "main",
    runtimeOf: async (chatId) => `session-${chatId}`,
    runner: {
      runAndReport: async (params, options) => {
        runs.push({
          threadId: params.threadId,
          ...(options?.providerOverride ? { providerOverride: options.providerOverride } : {}),
        });
        return "completed";
      },
    },
    notify: {
      send: async (content) => {
        pushes.push(content.body ?? "");
        return { kind: "sent" } as never;
      },
    },
    delay: async () => {},
  });
  const refreshed = (provider: ProviderId) => {
    for (const listener of listeners) listener(provider, "refreshed");
  };
  return { failures, messages, updates, settings, runs, pushes, refreshed };
}

const quota: AgentTurnFailure = {
  provider: "anthropic",
  message: "Claude usage limit reached",
  code: "usage_limit",
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("provider failures", () => {
  it("shows a card in an attended chat, naming the other provider that can run", async () => {
    const h = harness(
      { chat: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.failures.failed({
      chatId: "chat",
      agentName: "main",
      failure: { kind: "turn", failure: quota },
    });
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]?.parts[0]).toMatchObject({
      type: "provider_failure",
      provider: "anthropic",
      reason: "quota",
      followsDefault: true,
      alternatives: ["openai"],
    });
    expect(h.runs).toEqual([]);
  });

  it("says an exact selection is not following the default", async () => {
    const h = harness(
      { chat: { largeModelSelection: "claude-sonnet", largeModelSelectionBy: "owner" } },
      { anthropic: reportOf("unauthorized"), openai: reportOf("available") },
    );
    await h.failures.failed({
      chatId: "chat",
      agentName: "main",
      failure: {
        kind: "resolution",
        payload: {
          error: "x",
          code: "model_provider_unavailable",
          provider: "anthropic",
          reason: "not_logged_in",
        },
      },
    });
    expect(h.messages[0]?.parts[0]).toMatchObject({
      reason: "removed",
      followsDefault: false,
    });
  });

  it("retries a temporary failure once, silently, and never retries the retry", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("available") });
    const temporary: AgentTurnFailure = {
      provider: "anthropic",
      message: "overloaded",
      httpStatus: 529,
    };
    await h.failures.failed({
      chatId: "chat",
      agentName: "main",
      failure: { kind: "turn", failure: temporary },
    });
    expect(h.runs).toEqual([{ threadId: "chat" }]);
    expect(h.messages).toEqual([]);
  });

  it("groups unattended task chats into one notice and one push per outage", async () => {
    const h = harness(
      { a: { triggerKind: "concierge" }, b: { triggerKind: "concierge" }, main: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    for (const chatId of ["a", "b", "a"]) {
      await h.failures.failed({
        chatId,
        agentName: "main",
        failure: { kind: "turn", failure: quota },
      });
    }
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({ chatId: "main" });
    expect(h.pushes).toEqual([
      expect.stringMatching(/^Claude usage limit reached.*, 1 chat waiting$/),
    ]);
    expect(JSON.parse(h.updates.at(-1)?.content ?? "[]")[0]).toMatchObject({
      type: "provider_outage",
      chatIds: ["a", "b"],
    });
  });

  it("runs an outage's chats once on another provider, and closes the notice", async () => {
    const h = harness(
      { a: { triggerKind: "concierge" }, main: {} },
      { anthropic: reportOf("usage_limit_reached"), openai: reportOf("available") },
    );
    await h.failures.failed({
      chatId: "a",
      agentName: "main",
      failure: { kind: "turn", failure: quota },
    });
    const [outage] = await h.failures.outages();
    expect(await h.failures.runOutageOn(outage!.id, "openai")).toBe(1);
    await flush();
    expect(h.runs).toEqual([{ threadId: "a", providerOverride: "openai" }]);
    expect(h.settings.get(PROVIDER_OUTAGES_SETTING_KEY)).toEqual([]);
    expect(JSON.parse(h.updates.at(-1)?.content ?? "[]")[0].resolvedAt).toBeDefined();
  });

  it("closes the notice when the provider runs again", async () => {
    const reports: ModelAccountReports = {
      anthropic: reportOf("usage_limit_reached"),
      openai: reportOf("available"),
    };
    const h = harness({ a: { triggerKind: "concierge" }, main: {} }, reports);
    await h.failures.failed({
      chatId: "a",
      agentName: "main",
      failure: { kind: "turn", failure: quota },
    });
    reports.anthropic = reportOf("available");
    h.refreshed("anthropic");
    await flush();
    await flush();
    expect(await h.failures.outages()).toEqual([]);
  });

  it("ignores a failure that is neither a provider's nor temporary", async () => {
    const h = harness({ chat: {} }, { anthropic: reportOf("available") });
    const send = rs.fn();
    await h.failures.failed({
      chatId: "chat",
      agentName: "main",
      failure: { kind: "turn", failure: { provider: "anthropic", message: "prompt is too long" } },
    });
    expect(h.messages).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
