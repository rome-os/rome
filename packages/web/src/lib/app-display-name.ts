import type { InstalledAppCard } from "@rome/api-types/apps";

export function appDisplayName(
  appId: string | undefined,
  apps: readonly Pick<InstalledAppCard, "id" | "displayName">[] | null,
  placeholder: string,
): string {
  // A missing catalog is not evidence that an app is unknown, even if its
  // first request failed. Only a loaded catalog permits the id fallback.
  return (
    apps?.find((app) => app.id === appId)?.displayName ??
    (apps === null ? placeholder : (appId ?? placeholder))
  );
}
