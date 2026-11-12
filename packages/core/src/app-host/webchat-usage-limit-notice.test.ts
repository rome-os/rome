import { describe, expect, it, rs } from "@rstest/core";
import { startUsageLimitNotice } from "../webchat/usage-limit-notice.js";

type Listener = (provider: string, change: string, succeeded?: boolean) => void;

function fakeAccounts(initial: Record<string, string>) {
  let states = Object.fromEntries(Object.entries(initial).map(([p, state]) => [p, { state }]));
  const listeners = new Set<Listener>();
  const accounts = {
    read: () => states,
    onChanged: (listener: Listener) => (listeners.add(listener), () => listeners.delete(listener)),
  };
  const read = (provider: string, state: string, succeeded?: boolean) => {
    states = { ...states, [provider]: { state } };
    for (const listener of listeners) listener(provider, "refreshed", succeeded);
  };
  return { accounts: accounts as never, read };
}

describe("usage-limit notice", () => {
  it("sends one notice when a limited provider becomes available, and none for a re-read", () => {
    const { accounts, read } = fakeAccounts({ anthropic: "usage_limit_reached" });
    const notify = rs.fn(async () => {});
    startUsageLimitNotice({ accounts, notify });
    read("anthropic", "usage_limit_reached");
    expect(notify).not.toHaveBeenCalled();
    read("anthropic", "available");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("model usage on anthropic is available again");
    read("anthropic", "available");
    expect(notify).toHaveBeenCalledTimes(1);
    read("anthropic", "usage_limit_reached");
    read("anthropic", "available");
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("says nothing for a provider's first read, a failed read, or after it is stopped", () => {
    const { accounts, read } = fakeAccounts({ openai: "usage_limit_reached" });
    const notify = rs.fn(async () => {});
    const stop = startUsageLimitNotice({ accounts, notify });
    read("anthropic", "available");
    read("openai", "available", false);
    expect(notify).not.toHaveBeenCalled();
    stop();
    read("openai", "available");
    expect(notify).not.toHaveBeenCalled();
  });
});
