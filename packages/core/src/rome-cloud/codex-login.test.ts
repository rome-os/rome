import { describe, expect, it, rs } from "@rstest/core";
import type { RomeCreditsView } from "@rome/api-types/rome-credits";
import { codexLoginFor, startCodexLoginChoice } from "./codex-login.js";
import {
  createModelAccounts,
  SharedCodexAccountService,
  type CodexLoginChoice,
  type ModelAccountChange,
  type ModelAccountReports,
  type ProviderId,
} from "../agent/index.js";
import { reportOf } from "../test/kit/model-accounts.js";

const view = (overrides: Partial<RomeCreditsView> = {}): RomeCreditsView => ({
  grantedMicros: "5000000",
  balanceMicros: "5000000",
  availableMicros: "5000000",
  enabled: true,
  ...overrides,
});

const SUBSCRIPTION: CodexLoginChoice = { kind: "subscription" };
const CREDITS: CodexLoginChoice = { kind: "rome_credits", credentialId: "romeinst_123" };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A running choice over fake accounts, recording each login it asks Codex to use that differs. */
function choice(fetchCredits: () => Promise<RomeCreditsView | null> = async () => view()) {
  const value: ModelAccountReports = { openai: reportOf("available") };
  const listeners = new Set<(provider: ProviderId, change: ModelAccountChange) => void>();
  let credentialListener = () => {};
  let credential: string | null = "romeinst_123";
  let romeCloud = true;
  let current: CodexLoginChoice = SUBSCRIPTION;
  const used: CodexLoginChoice[] = [];
  const stop = startCodexLoginChoice({
    accounts: {
      read: () => value,
      onChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    logins: {
      login: () => (current.kind === "rome_credits" ? { ...current, modelsServed: null } : current),
      useLogin: (login) => {
        if (JSON.stringify(login) !== JSON.stringify(current)) used.push(login);
        current = login;
      },
    },
    getCredentialId: () => credential,
    hasRomeCloud: () => romeCloud,
    fetchRomeCredits: fetchCredits,
    onCredentialChanged: (listener) => {
      credentialListener = listener;
      return () => {};
    },
  });
  const accountChanged = async (change: ModelAccountChange) => {
    for (const listener of listeners) listener("openai", change);
    await flush();
  };
  return {
    stop,
    used,
    login: () => current,
    listeners,
    /** ChatGPT's account now reads `state`, and the accounts say the authorization changed. */
    authorization: async (state: Parameters<typeof reportOf>[0]) => {
      value.openai = reportOf(state);
      await accountChanged("authorization");
    },
    /** A read of the account that changed nothing about the authorization. */
    accountRead: () => accountChanged("refreshed"),
    credentialChanged: async (next: string | null) => {
      credential = next;
      credentialListener();
      await flush();
    },
    setRomeCloud: (next: boolean) => {
      romeCloud = next;
    },
  };
}

describe("codexLoginFor", () => {
  const openai = reportOf("unauthorized");

  it("uses Rome credits while ChatGPT is out, the instance is linked and credits can be spent", () => {
    expect(codexLoginFor({ openai, credentialId: "romeinst_123", credits: view() })).toEqual(
      CREDITS,
    );
    expect(
      codexLoginFor({
        openai: reportOf("expired"),
        credentialId: "romeinst_123",
        credits: view(),
      }),
    ).toEqual(CREDITS);
  });

  it.each([
    ["an authorized account", reportOf("available")],
    ["a usage limit alone", reportOf("usage_limit_reached")],
    ["an account not read yet", undefined],
  ])("keeps the subscription login for %s", (_label, report) => {
    expect(
      codexLoginFor({ openai: report, credentialId: "romeinst_123", credits: view() }),
    ).toEqual(SUBSCRIPTION);
  });

  it("keeps the subscription login on an instance that is not linked", () => {
    expect(codexLoginFor({ openai, credentialId: null, credits: view() })).toEqual(SUBSCRIPTION);
  });

  it.each([
    ["no grant", null],
    ["inference disabled", view({ enabled: false })],
    ["a used-up balance", view({ balanceMicros: "0", availableMicros: "0" })],
    ["an overrun", view({ balanceMicros: "-1200", availableMicros: "-1200" })],
  ])("keeps the subscription login for %s", (_label, credits) => {
    expect(codexLoginFor({ openai, credentialId: "romeinst_123", credits })).toEqual(SUBSCRIPTION);
  });
});

describe("startCodexLoginChoice", () => {
  it("moves to Rome credits when ChatGPT disconnects and back when it returns", async () => {
    const c = choice();
    await c.authorization("usage_limit_reached");
    expect(c.used).toEqual([]);
    await c.authorization("unauthorized");
    expect(c.used).toEqual([CREDITS]);
    await c.authorization("available");
    expect(c.used).toEqual([CREDITS, SUBSCRIPTION]);
    c.stop();
  });

  it("does not read the credits while ChatGPT is in", async () => {
    const fetch = rs.fn(async () => view());
    const c = choice(fetch);
    await c.accountRead();
    expect(fetch).not.toHaveBeenCalled();
    c.stop();
  });

  it("keeps the subscription login without a Rome Cloud origin", async () => {
    const fetch = rs.fn(async () => view());
    const c = choice(fetch);
    c.setRomeCloud(false);
    await c.authorization("unauthorized");
    expect(c.used).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    c.stop();
  });

  it("starts on Rome credits after a grant arrives", async () => {
    let granted = false;
    const c = choice(async () => (granted ? view() : null));
    await c.authorization("unauthorized");
    expect(c.used).toEqual([]);
    granted = true;
    await c.accountRead();
    expect(c.used).toEqual([CREDITS]);
    c.stop();
  });

  it("leaves Rome credits after the balance runs out or the gateway rejects the credential", async () => {
    let answer: RomeCreditsView | null = view();
    const c = choice(async () => answer);
    await c.authorization("unauthorized");
    answer = view({ availableMicros: "0" });
    await c.accountRead();
    expect(c.login()).toEqual(SUBSCRIPTION);
    answer = view();
    await c.accountRead();
    expect(c.login()).toEqual(CREDITS);
    answer = null;
    await c.accountRead();
    expect(c.login()).toEqual(SUBSCRIPTION);
    c.stop();
  });

  it("keeps the login when a read fails", async () => {
    let fail = false;
    const c = choice(async () => {
      if (fail) throw new Error("down");
      return view();
    });
    await c.authorization("unauthorized");
    fail = true;
    await c.accountRead();
    expect(c.login()).toEqual(CREDITS);
    c.stop();
  });

  it("keeps one read in flight", async () => {
    const answers: Array<(v: RomeCreditsView) => void> = [];
    const fetch = rs.fn(() => new Promise<RomeCreditsView>((resolve) => answers.push(resolve)));
    const c = choice(fetch);
    await c.authorization("unauthorized");
    await c.accountRead();
    expect(fetch).toHaveBeenCalledTimes(1);
    answers[0]?.(view());
    await flush();
    expect(c.login()).toEqual(CREDITS);
    c.stop();
  });

  it("ignores a read that ChatGPT signing in overtook", async () => {
    let answer: ((v: RomeCreditsView) => void) | undefined;
    const c = choice(() => new Promise<RomeCreditsView>((resolve) => (answer = resolve)));
    await c.authorization("unauthorized");
    await c.authorization("available");
    answer?.(view());
    await flush();
    expect(c.used).toEqual([]);
    c.stop();
  });

  it("moves to a new credential at once and lets its read decide", async () => {
    const NEXT: CodexLoginChoice = { kind: "rome_credits", credentialId: "romeinst_456" };
    const answers: Array<(v: RomeCreditsView | null) => void> = [];
    const c = choice(() => new Promise<RomeCreditsView | null>((resolve) => answers.push(resolve)));
    await c.authorization("unauthorized");
    answers[0]?.(view());
    await flush();

    await c.credentialChanged("romeinst_456");
    expect(c.used).toEqual([CREDITS, NEXT]);
    answers[1]?.(null);
    await flush();
    expect(c.used).toEqual([CREDITS, NEXT, SUBSCRIPTION]);
    c.stop();
  });

  it("keeps Rome credits on a new credential when its read fails", async () => {
    let fail = false;
    const c = choice(async () => {
      if (fail) throw new Error("down");
      return view();
    });
    await c.authorization("unauthorized");
    fail = true;
    await c.credentialChanged("romeinst_456");
    expect(c.login()).toEqual({ kind: "rome_credits", credentialId: "romeinst_456" });
    c.stop();
  });

  it("drops a read of the old credential", async () => {
    const answers: Array<(v: RomeCreditsView | null) => void> = [];
    const c = choice(() => new Promise<RomeCreditsView | null>((resolve) => answers.push(resolve)));
    await c.authorization("unauthorized");
    await c.credentialChanged("romeinst_456");
    answers[0]?.(view());
    await flush();
    expect(c.used).toEqual([]);
    answers[1]?.(view());
    await flush();
    expect(c.login()).toEqual({ kind: "rome_credits", credentialId: "romeinst_456" });
    c.stop();
  });

  it("goes to the subscription login when the credential is cleared", async () => {
    const c = choice();
    await c.authorization("unauthorized");
    await c.credentialChanged(null);
    expect(c.login()).toEqual(SUBSCRIPTION);
    c.stop();
  });

  it("uses no login after it stops", async () => {
    let answer: ((v: RomeCreditsView) => void) | undefined;
    const c = choice(() => new Promise<RomeCreditsView>((resolve) => (answer = resolve)));
    await c.authorization("unauthorized");
    c.stop();
    answer?.(view());
    await flush();
    expect(c.used).toEqual([]);
    expect(c.listeners.size).toBe(0);
  });

  it("holds Rome credits when Codex rejects the saved ChatGPT login", async () => {
    // Codex hides an unusable ChatGPT login on the subscription login, and on
    // Rome credits it hides every OpenAI account.
    let current: CodexLoginChoice = SUBSCRIPTION;
    const useLogin = rs.fn((next: CodexLoginChoice) => {
      current = next;
    });
    const rpc = {
      request: async <T>(method: string): Promise<T> => {
        if (method !== "account/read") throw new Error(`unexpected ${method}`);
        return { account: null, requiresOpenaiAuth: current.kind !== "rome_credits" } as T;
      },
      onNotification: () => () => {},
      onExit: () => () => {},
      login: () => current,
      useLogin,
    };
    let marked = false;
    const account = new SharedCodexAccountService(rpc, {
      usageCachePaths: [],
      markAuthRevoked: async () => {
        marked = true;
      },
      readFileStatus: async () =>
        marked
          ? { loggedIn: false, authMode: "chatgpt", needsReauth: true }
          : { loggedIn: true, authMode: "chatgpt" },
      readRomeCredits: async () => view(),
    });
    const accounts = createModelAccounts({
      accounts: { openai: account },
      refreshIntervalMs: null,
      startRefresh: false,
    });
    const stop = startCodexLoginChoice({
      accounts,
      logins: account,
      getCredentialId: () => "romeinst_123",
      hasRomeCloud: () => true,
      fetchRomeCredits: async () => view(),
      onCredentialChanged: () => () => {},
    });

    for (let hour = 0; hour < 3; hour++) {
      await accounts.refresh("openai");
      await flush();
    }

    const logins = useLogin.mock.calls.map(([login]) => login);
    expect(logins.slice(logins.indexOf(CREDITS))).not.toContainEqual(SUBSCRIPTION);
    expect(current).toEqual(CREDITS);
    expect(accounts.read().openai).toMatchObject({ state: "expired" });
    stop();
    accounts.close();
    account.close();
  });
});
