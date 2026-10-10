import type {
  AppInstallResponse,
  AppListResponse,
  AppPublishResponse,
  AppReadmeResponse,
  InstalledAppCard,
  SpecSource,
} from "@rome/api-types/apps";
import { APP_MANAGER_ERROR_STATUS } from "@rome/api-types/app-manager-errors";
import { deriveAppRuntimeStatus } from "@rome/api-types/apps-runtime";
import { http, HttpResponse } from "msw";
import type { UpgradeCandidate } from "@/hooks/use-apps";
import { publicAccess } from "./settings";
import { recordedApps } from "./recorded-apps";

// Catalog scope and recording limitations: docs/dashboard-mock-mode.md.
const apps: InstalledAppCard[] = structuredClone(recordedApps);
const upgradable: UpgradeCandidate[] = [];

/** The app id a `POST /apps` source resolves to — the daemon derives it from
 *  the artifact; here the fixtures encode the same mapping. */
function appIdForSource(source: SpecSource): string | null {
  if (source.mode === "appstore") return source.listingId;
  const leaf = source.path.split("/").filter(Boolean).pop();
  return leaf ?? null;
}

function cardFor(appId: string): InstalledAppCard | undefined {
  return apps.find((app) => app.id === appId);
}

/**
 * The card's derived half. Nothing here is stored on the row, because every
 * field below can be computed from something that is — and a stored copy is a
 * copy that can disagree.
 *
 * `status` comes from `deriveAppRuntimeStatus`, the same function the real
 * route calls: a failed app stays failed however its `enabled` flag moves, so
 * "active" can never pair with a `failed` phase. `href`/`fullHref` follow from
 * that status, so a card only offers to open an app that could actually serve
 * one. Access mode comes from the `/api/public-access` store the access dialog
 * writes to, so a just-changed dialog and the card's badge agree on the next read.
 */
function toCard(app: InstalledAppCard): InstalledAppCard {
  const emails = publicAccess.config.cloudEmailAccess[app.id] ?? [];
  const isPublic = publicAccess.config.allowedApps.includes(app.id);
  const status = deriveAppRuntimeStatus(app.phase, app.isEnabled);
  const openable = status === "active" && app.hasFrontend;
  return {
    ...app,
    status,
    href: openable ? `/apps/${app.id}` : null,
    fullHref: openable ? `/full/apps/${app.id}` : null,
    isPublic,
    cloudAllowedEmails: emails,
    accessMode: isPublic ? "public" : emails.length > 0 ? "cloud-email" : "private",
  };
}

export const appHandlers = [
  http.get("/api/app-store/listings/*", () =>
    HttpResponse.json({ error: "Listing not included in the demo" }, { status: 404 }),
  ),
  http.get("/api/apps", () =>
    HttpResponse.json({ apps: apps.map(toCard) } satisfies AppListResponse),
  ),
  // Both literal routes must precede any "/api/apps/:appId" pattern — MSW serves
  // the first handler whose path matches, and ":appId" would swallow them.
  http.get("/api/apps/updates", () => HttpResponse.json({ upgradable })),
  // Hold the catalog's SSE channel open without emitting: the fixture list only
  // changes through this file's own mutations, which invalidate the query
  // directly, and a stream that closes reads as a dropped connection.
  http.get("/api/apps/events", () => {
    const stream = new ReadableStream({ start() {} });
    return new HttpResponse(stream, { headers: { "Content-Type": "text/event-stream" } });
  }),
  http.get("/api/app-readmes/:appId", ({ params }) => {
    const appId = String(params.appId);
    if (!cardFor(appId)) return HttpResponse.json({ error: "Unknown app" }, { status: 404 });
    return HttpResponse.json({
      appId,
      readme: null,
    } satisfies AppReadmeResponse);
  }),
  // Install or upgrade. The upgrade path is the one reachable from the grid:
  // it re-installs an already-installed app from a newer source, so the version
  // moves and the candidate that advertised it is retired.
  http.post("/api/apps", async ({ request }) => {
    const body = (await request.json()) as { source: SpecSource };
    const appId = appIdForSource(body.source);
    const app = appId ? cardFor(appId) : undefined;
    if (!app) {
      return HttpResponse.json({ error: "Unknown app source" }, { status: 400 });
    }
    if (body.source.mode === "appstore") app.version = body.source.version;
    // `source` is the card's authoritative reinstall source, so the accepted
    // source has to replace it — otherwise the next read advertises the version
    // that was just upgraded away from. The real route echoes the submitted
    // source back for the same reason.
    app.source = body.source;
    const candidateIndex = upgradable.findIndex((candidate) => candidate.appId === app.id);
    if (candidateIndex >= 0) upgradable.splice(candidateIndex, 1);
    return HttpResponse.json({
      appId: app.id,
      spec: { source: body.source, enabled: app.isEnabled },
      phase: app.phase,
    } satisfies AppInstallResponse);
  }),
  http.patch("/api/apps/:appId", async ({ params, request }) => {
    const app = cardFor(String(params.appId));
    if (!app) return HttpResponse.json({ error: "Unknown app" }, { status: 404 });
    const body = (await request.json()) as { enabled: boolean };
    // Only the flag is stored. Status and the open links are derived per read,
    // so enabling an app whose phase is `failed` cannot promote it to active.
    app.isEnabled = body.enabled;
    return HttpResponse.json({
      appId: app.id,
      spec: { source: app.source, enabled: app.isEnabled },
      phase: app.phase,
    } satisfies AppInstallResponse);
  }),
  http.delete("/api/apps/:appId", ({ params }) => {
    const appId = String(params.appId);
    const index = apps.findIndex((app) => app.id === appId);
    if (index < 0) return HttpResponse.json({ error: "Unknown app" }, { status: 404 });
    // The daemon rejects uninstalling a first-party app; a fixture that allowed
    // it would model a card state the real backend can't produce. The status
    // comes from the shared table rather than a number chosen here, so the mock
    // cannot answer a different class than the route does.
    if (!apps[index].canUninstall) {
      return HttpResponse.json(
        {
          error: `FIRST_PARTY_PROTECTED: App "${appId}" ships with Rome and cannot be uninstalled`,
        },
        { status: APP_MANAGER_ERROR_STATUS.FIRST_PARTY_PROTECTED },
      );
    }
    apps.splice(index, 1);
    const candidateIndex = upgradable.findIndex((candidate) => candidate.appId === appId);
    if (candidateIndex >= 0) upgradable.splice(candidateIndex, 1);
    return HttpResponse.json({ ok: true });
  }),
  http.post("/api/apps/:appId/publish", ({ params }) => {
    const app = cardFor(String(params.appId));
    if (!app) return HttpResponse.json({ error: "Unknown app" }, { status: 404 });
    if (!app.canPublish) {
      return HttpResponse.json({ error: "This app cannot be published" }, { status: 403 });
    }
    return HttpResponse.json({
      appId: app.id,
      listing: { id: `listing-${app.id}`, handle: `mock-guardian/${app.id}`, slug: app.id },
      version: {
        version: app.version,
        contentHash: "a".repeat(64),
        sizeBytes: 128_400,
        sourceAvailable: true,
      },
      claimed: true,
    } satisfies AppPublishResponse);
  }),
];
