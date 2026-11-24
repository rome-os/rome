// What agents do on the AI Tools page: read which AI tools Rome can use and
// which one is the default, open the page's sign-in in a card, log out of
// one, and change the default. The page reads the same accounts and default
// (`GET /api/ai-tools/status`), logs out through the same operation
// (agent/application/model-logout.ts) and changes the default through the
// same `DefaultProviders.choose`. The sign-in card embeds the page's own
// sign-in panel for the AI tools it names. Vocabulary: docs/domains/agents.md.
// How a tool is declared: docs/concepts/actions.md#core-agent-tools.
//
// The agent context never imports apps/, so these tools live beside the
// page's routes rather than in agent/.

import {
  AI_TOOL_SIGN_IN_CARD_ID,
  type AiToolSignInCardProps,
} from "@rome/api-types/ai-tool-sign-in-card";
import { z } from "zod";
import {
  type AccountedProviderId,
  type DefaultProvider,
  type DefaultProviders,
  type ModelAccountReport,
  type ModelAccounts,
  type ModelLogoutDeps,
  logOutOfProvider,
  providerAuthorized,
} from "../../agent/index.js";
import { agentToolsOf, card, toolError } from "../../apps/actions/agent-tool.js";
import { getErrorMessage } from "../../lib/error-message.js";

export interface AiToolDeps extends ModelLogoutDeps {
  accounts: Pick<ModelAccounts, "read" | "refresh">;
  defaults: Pick<DefaultProviders, "ready" | "current" | "signedIn" | "choose" | "expectLogout">;
  /** How many chats follow the default, which a change of it moves. */
  chatsFollowingDefault: () => Promise<number>;
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

const DISPLAY_NAMES: Record<DefaultProvider, string> = {
  anthropic: "Claude",
  openai: "ChatGPT",
  rome_credits: "Rome credits",
};

const aiTool = z
  .enum(["claude", "chatgpt"])
  .describe('The AI tool: "claude" for Claude, "chatgpt" for ChatGPT.');

const moveExistingChats = z
  .boolean()
  .optional()
  .describe(
    "Whether the chats already running move too, each on its next reply. Default true. False keeps them where they run. A chat whose model the guardian picked keeps it either way.",
  );

const agentTool = agentToolsOf<AiToolDeps>();

/** The one tool that shows the sign-in card (api/routes/webchat.ts). */
export const SIGN_IN_AI_TOOL = "system:sign_in_ai_tool";

export const readAiTools = agentTool({
  name: "system:read_ai_tools",
  description:
    "See which AI tools Rome can use (Claude and ChatGPT), whether each is signed in, signed out, needs signing in again or has reached its usage limit, and which one is the default that chats run on. Use it when the guardian asks which AI Rome uses, whether Claude or ChatGPT is signed in, why chats stopped replying because of a sign-in or a usage limit, or before signing in, signing out or changing the default",
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
      // Rome credits run chats only while no AI tool is signed in.
      romeCredits: { canRunChats: signedIn.rome_credits, isDefault: current === "rome_credits" },
      default: current ? DEFAULT_NAMES[current] : null,
      // Every chat follows the default, except one whose model the guardian picked.
      chatsFollowingDefault: await deps.chatsFollowingDefault().catch(() => null),
    };
  },
});

export const signInAiTool = agentTool({
  name: SIGN_IN_AI_TOOL,
  description:
    "Ask the guardian to sign in to an AI tool, Claude or ChatGPT, through a card in the chat where they finish the sign-in, whether or not another AI tool is signed in. Use it when the guardian asks to sign in to, connect or add Claude or ChatGPT, when a sign-in expired, or when no AI tool is signed in and chats cannot run. Only in the guardian's private chat, in a turn their own message started. Check what is signed in with system:read_ai_tools",
  sideEffects: "write",
  input: z.object({
    aiTool: aiTool
      .optional()
      .describe(
        'The AI tool: "claude" for Claude, "chatgpt" for ChatGPT. Default: every one not signed in.',
      ),
  }),
  run: async (input, { deps }) => {
    const reports = deps.accounts.read();
    const asked = input.aiTool ? [input.aiTool] : (Object.keys(AI_TOOLS) as AiTool[]);
    const aiTools = asked.filter((id) => !signedInNow(reports[AI_TOOLS[id].provider]));
    if (aiTools.length === 0) {
      return {
        message: input.aiTool
          ? `${AI_TOOLS[input.aiTool].name} is already signed in. No card shown.`
          : "Claude and ChatGPT are both signed in. No card shown.",
      };
    }
    const names = aiTools.map((id) => AI_TOOLS[id].name).join(" or ");
    return card({
      componentId: AI_TOOL_SIGN_IN_CARD_ID,
      props: { aiTools } satisfies AiToolSignInCardProps,
      ask: `Sign in to ${names} in Settings › AI Tools.`,
    });
  },
});

export const signOutAiTool = agentTool({
  name: "system:sign_out_ai_tool",
  description:
    "Sign Rome out of an AI tool, Claude or ChatGPT, so Rome stops using that account. Use it when the guardian asks to sign out of, log out of, disconnect or remove Claude or ChatGPT. The guardian approves it on a card first. Only in the guardian's private chat, in a turn their own message started. Check what is signed in with system:read_ai_tools",
  sideEffects: "write",
  input: z.object({ aiTool, moveExistingChats }),
  // Shown to the guardian alone. The page's own dialog names the new default;
  // here the agent reads it after the logout with system:read_ai_tools.
  approval: async (input, { deps }) => {
    const { provider, name } = AI_TOOLS[input.aiTool];
    const isDefault = deps.defaults.current() === provider;
    const moves = input.moveExistingChats !== false;
    return {
      title: `Sign out of ${name}`,
      summary: [
        `Rome stops using your ${name} account. To use it again, you sign in again in Settings › AI Tools.`,
        isDefault
          ? moves
            ? "It is your default, so Rome makes another AI tool you can use the default, when there is one, and chats move to it, each on its next reply."
            : `It is your default, so Rome makes another AI tool you can use the default, when there is one. Chats already running stay on ${name} until you sign in again.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    };
  },
  run: async (input, { deps }) => {
    const { provider, name } = AI_TOOLS[input.aiTool];
    const report = deps.accounts.read()[provider];
    if (report?.state === "unauthorized") {
      return toolError(`${name} is not signed in, so there is nothing to sign out of.`);
    }
    try {
      await logOutOfProvider(deps, provider, { moveExisting: input.moveExistingChats !== false });
    } catch (err) {
      return toolError(
        `Signing out of ${name} failed: ${getErrorMessage(err)}. Tell the guardian they can sign out in Settings › AI Tools.`,
      );
    }
    const current = deps.defaults.current();
    return {
      aiTool: input.aiTool,
      signedOut: true,
      default: current ? DEFAULT_NAMES[current] : null,
    };
  },
});

export const changeAiTool = agentTool({
  name: "system:change_ai_tool",
  description:
    "Change which AI tool Rome uses by default, Claude, ChatGPT or Rome credits. Every chat runs on the default, except one whose model the guardian picked. Use it when the guardian asks Rome to use Claude or ChatGPT, to switch AI tools, or to make one the default. The AI tool must be signed in. Only in the guardian's private chat, in a turn their own message started. Check what is signed in with system:read_ai_tools",
  sideEffects: "write",
  input: z.object({
    aiTool: z
      .enum(["claude", "chatgpt", "rome_credits"])
      .describe(
        'The AI tool to use by default: "claude", "chatgpt", or "rome_credits", which can be the default only while no AI tool is signed in.',
      ),
    moveExistingChats,
  }),
  run: async (input, { deps }) => {
    const provider = providerOf(input.aiTool);
    const name = DISPLAY_NAMES[provider];
    await deps.defaults.ready();
    if (deps.defaults.current() === provider) {
      return { default: input.aiTool, changed: false, message: `${name} is already the default.` };
    }
    try {
      await deps.defaults.choose(provider, { moveExisting: input.moveExistingChats !== false });
    } catch {
      return toolError(
        provider === "rome_credits"
          ? "Rome credits can be the default only while no AI tool is signed in and credits are left. Check with system:read_ai_tools."
          : `${name} is not signed in, so it cannot be the default. Ask the guardian to sign in with system:sign_in_ai_tool.`,
      );
    }
    return { default: input.aiTool, changed: true };
  },
});

/** The AI Tools page's agent tools. */
export const aiToolTools = [readAiTools, signInAiTool, signOutAiTool, changeAiTool];

function providerOf(name: "claude" | "chatgpt" | "rome_credits"): DefaultProvider {
  return name === "rome_credits" ? "rome_credits" : AI_TOOLS[name].provider;
}

/** Signed in and usable now, as the page counts it: an expired sign-in is not. */
function signedInNow(report: ModelAccountReport | undefined): boolean {
  return report !== undefined && providerAuthorized(report);
}

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
