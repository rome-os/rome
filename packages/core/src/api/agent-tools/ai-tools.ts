// What agents do on the AI Tools page: read which AI tools Rome can use and
// which one is the default. The page reads the same accounts and default
// (`GET /api/ai-tools/status`). Vocabulary: docs/domains/agents.md.
// How a tool is declared: docs/concepts/actions.md#core-agent-tools.
//
// The agent context never imports apps/, so its tools live beside the
// page's routes rather than in agent/.

import { z } from "zod";
import type {
  AccountedProviderId,
  DefaultProvider,
  DefaultProviders,
  ModelAccountReport,
  ModelAccounts,
} from "../../agent/index.js";
import { agentToolsOf } from "../../apps/actions/agent-tool.js";

export interface AiToolDeps {
  accounts: Pick<ModelAccounts, "read">;
  defaults: Pick<DefaultProviders, "ready" | "current" | "signedIn">;
  /** How many chats follow the default. */
  chatsFollowingDefault: () => Promise<number>;
  /** Whether the instance has Rome credits it can spend, not only credits enabled. */
  romeCreditsUsable: () => boolean;
  /** The service a Claude key stored in AI Tools reaches, such as DeepSeek; null for none. */
  claudeKeyService: () => Promise<string | null>;
}

/** The AI tools the guardian logs in to, by the names the page shows. */
const AI_TOOLS = {
  claude: { provider: "anthropic", name: "Claude" },
  chatgpt: { provider: "openai", name: "ChatGPT" },
} as const satisfies Record<string, { provider: AccountedProviderId; name: string }>;

type AiTool = keyof typeof AI_TOOLS;

/** The default as the agent names it. */
const DEFAULT_NAMES: Record<DefaultProvider, "claude" | "chatgpt" | "rome_credits"> = {
  anthropic: "claude",
  openai: "chatgpt",
  rome_credits: "rome_credits",
};

const agentTool = agentToolsOf<AiToolDeps>();

export const readAiTools = agentTool({
  name: "system:read_ai_tools",
  description:
    "See which AI tools Rome can use (Claude and ChatGPT), whether each is signed in, signed out, needs signing in again or has reached its usage limit, and which one is the default that chats run on. Use it when the guardian asks which AI Rome uses, whether Claude or ChatGPT is signed in, why chats stopped replying because of a sign-in or a usage limit. The guardian signs in, signs out and changes the default in Settings › AI Tools",
  sideEffects: "read-only",
  input: z.object({}),
  run: async (_input, { deps }) => {
    await deps.defaults.ready();
    const reports = deps.accounts.read();
    const current = deps.defaults.current();
    const signedIn = deps.defaults.signedIn();
    const claudeKey = await deps.claudeKeyService();
    return {
      aiTools: (Object.keys(AI_TOOLS) as AiTool[]).map((id) => {
        const { provider, name } = AI_TOOLS[id];
        const report = reports[provider];
        return {
          aiTool: id,
          name,
          ...standing(report),
          ...(id === "claude" && claudeKey ? { through: claudeKey } : {}),
          isDefault: current === provider,
        };
      }),
      // Rome credits run chats only while no AI tool is signed in and credits are left.
      romeCredits: {
        canRunChats: signedIn.rome_credits && deps.romeCreditsUsable(),
        isDefault: current === "rome_credits",
      },
      default: current ? DEFAULT_NAMES[current] : null,
      // Every chat follows the default, except one whose model the guardian picked.
      chatsFollowingDefault: await deps.chatsFollowingDefault().catch(() => null),
    };
  },
});

/** The AI Tools page's agent tools. */
export const aiToolTools = [readAiTools];

/** How the account stands, as the page shows it. No credential is listed. */
function standing(report: ModelAccountReport | undefined) {
  if (!report) return { status: "not_checked_yet" as const };
  const { state, usageLimitUntil, account } = report;
  return {
    status:
      state === "available"
        ? ("signed_in" as const)
        : state === "unauthorized"
          ? ("signed_out" as const)
          : state === "expired"
            ? ("sign_in_expired" as const)
            : ("usage_limit_reached" as const),
    ...(usageLimitUntil ? { usageLimitUntil } : {}),
    ...(state !== "unauthorized" && account.email ? { account: account.email } : {}),
    ...(state !== "unauthorized" && account.planType ? { plan: account.planType } : {}),
  };
}
