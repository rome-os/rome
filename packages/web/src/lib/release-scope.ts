/** Scopes whose name is not the scope capitalized. */
const SCOPE_NAMES: Record<string, string> = {
  ai: "AI",
  api: "API",
  cdp: "Browser",
  ci: "CI",
  db: "Database",
  ios: "iOS",
  mcp: "MCP",
  sdk: "SDK",
  ui: "UI",
  "app-runtime": "App runtime",
  "app-web-sdk": "App SDK",
};

/**
 * A Conventional Commit scope as a guardian reads it: `ios` is iOS,
 * `concierge` is Concierge, `web-chat` is Web chat.
 */
export function scopeName(scope: string): string {
  const known = SCOPE_NAMES[scope.toLowerCase()];
  if (known) return known;
  const words = scope.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
