import { AiToolsPanel } from "@/components/ai-tools-panel";

const HIDDEN_PROVIDERS = ["gemini", "grok"] as const;

/**
 * The Claude and ChatGPT sign-ins, embedded in a chat card the way the
 * connect step's AI tools card embeds them. The panel reads the default
 * provider again after each status read, so the card sees a sign-in land.
 */
export function ProviderSignIn() {
  return <AiToolsPanel hiddenProviders={HIDDEN_PROVIDERS} showHeader={false} showUsage={false} />;
}
