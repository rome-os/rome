import { describe, expect, it } from "@rstest/core";
import type { DefaultProvider, ModelAccountReports } from "../../agent/index.js";
import { approvalOf, callTool, whoMayAskSuite } from "../../apps/actions/agent-tool-contract.js";
import { reportOf } from "../../test/kit/model-accounts.js";
import { type AiToolDeps, changeAiTool, readAiTools, signOutAiTool } from "./ai-tools.js";

whoMayAskSuite(readAiTools, {});
whoMayAskSuite(signOutAiTool, { aiTool: "claude" });
whoMayAskSuite(changeAiTool, { aiTool: "chatgpt" });

/** A Rome with these accounts and default. Records what the tools changed. */
function rome(options: {
  reports: ModelAccountReports;
  current?: DefaultProvider | null;
  claudeKeyService?: string | null;
  revokeFails?: boolean;
}) {
  const calls: string[] = [];
  let current = options.current ?? null;
  let reports = options.reports;
  const signedIn = () => ({
    anthropic: reports.anthropic !== undefined && reports.anthropic.state !== "unauthorized",
    openai: reports.openai !== undefined && reports.openai.state !== "unauthorized",
    rome_credits: false,
  });
  const revoke = (provider: "anthropic" | "openai") => async () => {
    if (options.revokeFails) throw new Error("the provider refused");
    calls.push(`revoke ${provider}`);
  };
  const deps: AiToolDeps = {
    accounts: {
      read: () => reports,
      refresh: async (provider) => {
        calls.push(`refresh ${provider}`);
        if (provider) reports = { ...reports, [provider]: reportOf("unauthorized") };
        // A logout of the default moves it to the other signed-in account.
        if (provider && current === provider) {
          current = provider === "anthropic" ? "openai" : "anthropic";
        }
        return true;
      },
    },
    defaults: {
      ready: async () => {},
      current: () => current,
      signedIn,
      choose: async (provider, { moveExisting } = {}) => {
        if (!signedIn()[provider]) throw new Error(`${provider} is not signed in`);
        calls.push(`choose ${provider} moveExisting=${moveExisting}`);
        current = provider;
      },
      expectLogout: (provider, { moveExisting }) => {
        calls.push(`expect logout ${provider} moveExisting=${moveExisting}`);
        return async () => {
          calls.push(`logout of ${provider} failed`);
        };
      },
    },
    logins: { anthropic: { revoke: revoke("anthropic") }, openai: { revoke: revoke("openai") } },
    chatsFollowingDefault: async () => 3,
    claudeKeyService: async () => options.claudeKeyService ?? null,
  };
  return { deps, calls };
}

describe("reading the AI tools", () => {
  it("lists each AI tool's sign-in, the account it reaches and the default chats run on", async () => {
    const { deps } = rome({
      reports: {
        anthropic: reportOf("available", { email: "g@example.test", planType: "pro" }),
        openai: reportOf("usage_limit_reached", {}, "2026-11-24T12:00:00.000Z"),
      },
      current: "anthropic",
    });

    const result = await callTool(readAiTools, deps, {});

    expect(result).toEqual({
      status: "ok",
      data: {
        aiTools: [
          {
            aiTool: "claude",
            name: "Claude",
            status: "signed_in",
            account: "g@example.test",
            plan: "pro",
            isDefault: true,
          },
          {
            aiTool: "chatgpt",
            name: "ChatGPT",
            status: "usage_limit_reached",
            usageLimitUntil: "2026-11-24T12:00:00.000Z",
            isDefault: false,
          },
        ],
        romeCredits: { canRunChats: false, isDefault: false },
        default: "claude",
        chatsFollowingDefault: 3,
      },
    });
  });

  it("says a sign-in that expired, an account not read yet, and the service a Claude key reaches", async () => {
    const { deps } = rome({
      reports: { anthropic: reportOf("expired", { email: "g@example.test" }) },
      claudeKeyService: "DeepSeek",
    });

    const result = await callTool(readAiTools, deps, {});

    expect(result.status === "ok" && result.data).toMatchObject({
      aiTools: [
        { aiTool: "claude", status: "sign_in_expired", through: "DeepSeek" },
        { aiTool: "chatgpt", status: "not_checked_yet" },
      ],
      default: null,
    });
  });
});

describe("signing out of an AI tool", () => {
  it("is approved by the guardian on a card that says the default moves", async () => {
    const { deps } = rome({
      reports: { anthropic: reportOf("available"), openai: reportOf("available") },
      current: "anthropic",
    });

    const preview = await approvalOf(signOutAiTool, deps, { aiTool: "claude" });

    expect(preview).toEqual({
      kind: "generic",
      title: "Sign out of Claude",
      summary:
        "Rome stops using your Claude account. To use it again, you sign in again in Settings › AI Tools. It is your default, so Rome makes another AI tool you can use the default, when there is one, and chats move to it, each on its next reply.",
    });
  });

  it("logs out as the page does, telling the default first whether chats move", async () => {
    const { deps, calls } = rome({
      reports: { anthropic: reportOf("available"), openai: reportOf("available") },
      current: "anthropic",
    });

    const result = await callTool(signOutAiTool, deps, {
      aiTool: "claude",
      moveExistingChats: false,
    });

    expect(result).toEqual({
      status: "ok",
      data: { aiTool: "claude", signedOut: true, default: "chatgpt" },
    });
    expect(calls).toEqual([
      "expect logout anthropic moveExisting=false",
      "revoke anthropic",
      "refresh anthropic",
    ]);
  });

  it("drops the default's expectation and says so when the logout fails", async () => {
    const { deps, calls } = rome({
      reports: { openai: reportOf("available") },
      revokeFails: true,
    });

    const result = await callTool(signOutAiTool, deps, { aiTool: "chatgpt" });

    expect(result).toEqual({
      status: "error",
      error:
        "Signing out of ChatGPT failed: the provider refused. Tell the guardian they can sign out in Settings › AI Tools.",
    });
    expect(calls).toEqual(["expect logout openai moveExisting=true", "logout of openai failed"]);
  });

  it("turns down an AI tool that is not signed in", async () => {
    const { deps, calls } = rome({ reports: { openai: reportOf("unauthorized") } });

    const result = await callTool(signOutAiTool, deps, { aiTool: "chatgpt" });

    expect(result).toEqual({
      status: "error",
      error: "ChatGPT is not signed in, so there is nothing to sign out of.",
    });
    expect(calls).toEqual([]);
  });
});

describe("changing the AI tool Rome uses", () => {
  it("makes a signed-in AI tool the default, moving existing chats unless told not to", async () => {
    const { deps, calls } = rome({
      reports: { anthropic: reportOf("available"), openai: reportOf("available") },
      current: "anthropic",
    });

    const moved = await callTool(changeAiTool, deps, { aiTool: "chatgpt" });
    const kept = await callTool(changeAiTool, deps, {
      aiTool: "claude",
      moveExistingChats: false,
    });

    expect(moved).toEqual({ status: "ok", data: { default: "chatgpt", changed: true } });
    expect(kept).toEqual({ status: "ok", data: { default: "claude", changed: true } });
    expect(calls).toEqual([
      "choose openai moveExisting=true",
      "choose anthropic moveExisting=false",
    ]);
  });

  it("changes nothing when the AI tool already is the default", async () => {
    const { deps, calls } = rome({
      reports: { anthropic: reportOf("available") },
      current: "anthropic",
    });

    const result = await callTool(changeAiTool, deps, { aiTool: "claude" });

    expect(result).toEqual({
      status: "ok",
      data: { default: "claude", changed: false, message: "Claude is already the default." },
    });
    expect(calls).toEqual([]);
  });

  it("turns down an AI tool that is not signed in, pointing to the sign-in", async () => {
    const { deps } = rome({ reports: { anthropic: reportOf("available") }, current: "anthropic" });

    const result = await callTool(changeAiTool, deps, { aiTool: "chatgpt" });

    expect(result).toEqual({
      status: "error",
      error:
        "ChatGPT is not signed in, so it cannot be the default. Ask the guardian to sign in in Settings › AI Tools.",
    });
  });
});
