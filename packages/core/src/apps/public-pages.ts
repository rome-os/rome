import { isAppApiPathNoAuth } from "./no-auth.js";
import { isResolvedApp, type AppView, type ResolvedApp } from "./state.js";

/** Match a decoded app-relative page path. Reject ambiguous router inputs. */
export function isAppPagePublic(app: AppView | ResolvedApp | null, path: string): boolean {
  if (!isResolvedApp(app) || !app.web || !app.enabled) return false;
  if (/[\\%?#\u0000-\u001f\u007f]/.test(path) || path.includes("//")) return false;
  if (path.split("/").some((part) => part === "." || part === "..")) return false;
  const subPath = path.startsWith("/") ? path : `/${path}`;
  return isAppApiPathNoAuth(app.manifest.web?.publicPaths ?? [], subPath);
}
