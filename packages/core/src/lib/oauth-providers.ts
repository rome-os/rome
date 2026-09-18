export const OAUTH_PROVIDERS = ["google", "github", "slack"] as const;

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export interface OAuthProviderDescriptor {
  id: OAuthProvider;
  label: string;
  description: string;
}

export const OAUTH_PROVIDER_DESCRIPTORS: Record<OAuthProvider, OAuthProviderDescriptor> = {
  google: {
    id: "google",
    label: "Google",
    description: "Workspace APIs, Drive, Gmail, Calendar, and Google identity.",
  },
  github: {
    id: "github",
    label: "GitHub",
    description: "Repositories, pull requests, issues, and GitHub identity.",
  },
  slack: {
    id: "slack",
    label: "Slack",
    description: "Read and post messages, channels, reactions, and search.",
  },
};

export function isOAuthProvider(value: string): value is OAuthProvider {
  return OAUTH_PROVIDERS.includes(value as OAuthProvider);
}

function envFlagEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

export function showGoogleOAuth(): boolean {
  return envFlagEnabled(process.env.SHOW_GOOGLE_OAUTH);
}

export function getEnabledOAuthProviders(): OAuthProvider[] {
  return OAUTH_PROVIDERS.filter((provider) => provider !== "google" || showGoogleOAuth());
}

export function isEnabledOAuthProvider(value: string): value is OAuthProvider {
  return isOAuthProvider(value) && getEnabledOAuthProviders().includes(value);
}
