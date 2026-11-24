import { describe, expect, it } from "@rstest/core";
import type { DefaultProvider, ModelAccountReports } from "../../agent/index.js";
import { callTool, whoMayAskSuite } from "../../apps/actions/agent-tool-contract.js";
import { reportOf } from "../../test/kit/model-accounts.js";
import { type AiToolDeps, readAiTools } from "./ai-tools.js";

whoMayAskSuite(readAiTools, {});

/** A Rome with these accounts and default. */
function rome(options: {
  reports: ModelAccountReports;
  current?: DefaultProvider | null;
  claudeKeyService?: string | null;
  romeCredits?: { enabled: boolean; spendable: boolean };
}): { deps: AiToolDeps } {
  const { reports } = options;
  const deps: AiToolDeps = {
    accounts: { read: () => reports },
    defaults: {
      ready: async () => {},
      current: () => options.current ?? null,
      signedIn: () => ({
        anthropic: reports.anthropic !== undefined && reports.anthropic.state !== "unauthorized",
        openai: reports.openai !== undefined && reports.openai.state !== "unauthorized",
        // As DefaultProviders reads it: credits enabled and no AI tool signed in.
        rome_credits:
          options.romeCredits?.enabled === true &&
          reports.anthropic?.state !== "available" &&
          reports.openai?.state !== "available",
      }),
    },
    chatsFollowingDefault: async () => 3,
    romeCreditsUsable: () => options.romeCredits?.spendable === true,
    claudeKeyService: async () => options.claudeKeyService ?? null,
  };
  return { deps };
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

  it("says Rome credits can run chats only while credits are left", async () => {
    const signedOut = {
      anthropic: reportOf("unauthorized"),
      openai: reportOf("unauthorized"),
    };
    const usedUp = rome({ reports: signedOut, romeCredits: { enabled: true, spendable: false } });
    const left = rome({ reports: signedOut, romeCredits: { enabled: true, spendable: true } });

    const usedUpResult = await callTool(readAiTools, usedUp.deps, {});
    const leftResult = await callTool(readAiTools, left.deps, {});

    expect(usedUpResult.status === "ok" && usedUpResult.data).toMatchObject({
      romeCredits: { canRunChats: false },
    });
    expect(leftResult.status === "ok" && leftResult.data).toMatchObject({
      romeCredits: { canRunChats: true },
    });
  });
});
