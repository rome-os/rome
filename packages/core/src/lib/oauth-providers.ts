export const OAUTH_PROVIDERS = ["google", "github", "slack", "shopify"] as const;

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
  shopify: {
    id: "shopify",
    label: "Shopify",
    description: "Products, inventory, and orders in your Shopify store.",
  },
};

// A store's permanent `.myshopify.com` domain, per Shopify's own validation.
const SHOPIFY_SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** The Shopify admin URL of a store, `admin.shopify.com/store/<handle>[/...]`. */
const SHOPIFY_ADMIN_STORE_URL = /^admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)(?:[/?#].*)?$/;

/**
 * Normalize what a guardian typed for their Shopify store to its
 * `<store>.myshopify.com` domain, or `null` when it isn't one. Accepts the bare
 * store handle (`acme`), the domain with an optional scheme and trailing slash,
 * or the store's admin URL (`https://admin.shopify.com/store/acme`), which is
 * the address a merchant has open.
 */
export function normalizeShopifyShopDomain(value: string | null | undefined): string | null {
  const trimmed = value
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!trimmed) return null;
  const adminHandle = SHOPIFY_ADMIN_STORE_URL.exec(trimmed)?.[1];
  if (adminHandle) return `${adminHandle}.myshopify.com`;
  const domain = trimmed.includes(".") ? trimmed : `${trimmed}.myshopify.com`;
  return SHOPIFY_SHOP_DOMAIN.test(domain) ? domain : null;
}

/** Providers whose expiring grants Rome Cloud can refresh. Any other provider's
 *  expiring grant answers "re-confer" without a round trip, and degrades at
 *  expiry until the guardian reconnects. */
export const ROME_CLOUD_REFRESHABLE_PROVIDERS: ReadonlySet<OAuthProvider> = new Set(["shopify"]);

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
