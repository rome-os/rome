import { Hono } from "hono";
import { appIdToPathSegment } from "@rome-os/app-runtime/packaging";
import type { ApiDeps } from "../deps.js";

/**
 * Lists skills currently loaded in the catalog so dashboard surfaces (the
 * Skills app, the chat composer's slash-command autocomplete) can offer them.
 * Metadata only — agents read skill bodies via the MCP facade (`read_skill`),
 * the SPA never needs them.
 */
export function skillsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/skills", (c) => {
    // Owning app's icon, resolved the same way as /chat/agents — lets the
    // composer render the skill under its app's identity (null = no icon;
    // the SPA falls back to the Rome mark).
    const apps = deps.appCatalog.listResolved();
    const appById = new Map(apps.map((app) => [app.appId, app]));
    const skills = deps.skillCatalog.getAll().map((skill) => {
      const resolved = appById.get(skill.metadata.ownerId);
      return {
        name: skill.name,
        localName: skill.localName,
        description: skill.description,
        tools: skill.tools ?? [],
        ownerType: skill.metadata.ownerType,
        ownerId: skill.metadata.ownerId,
        // Owner display identity, resolved the same way as /chat/agents — the
        // composer's slash menu groups skills by app like the @ mention menu.
        ownerLabel:
          skill.metadata.ownerType === "core"
            ? "Rome"
            : (resolved?.displayName ?? skill.metadata.ownerId),
        ownerDescription: resolved?.manifest.description ?? "",
        iconUrl: resolved?.iconAbsolutePath
          ? `/api/apps/${appIdToPathSegment(skill.metadata.ownerId)}/icon`
          : null,
      };
    });
    // App-owned skills that were declared but failed to load (e.g. bad
    // frontmatter, a name with whitespace) are dropped from the catalog
    // silently — without this the only trace is a worker `console.warn`. Surface
    // them so the Skills app can tell an author their skill exists but was
    // rejected, and why.
    const loadFailures = deps.skillCatalog.getRegistryLoadFailures().map((failure) => {
      const resolved = appById.get(failure.ownerId);
      return {
        publicName: failure.publicName,
        ownerId: failure.ownerId,
        ownerLabel: resolved?.displayName ?? failure.ownerId,
        sourcePath: failure.sourcePath,
        error: failure.error,
        iconUrl: resolved?.iconAbsolutePath
          ? `/api/apps/${appIdToPathSegment(failure.ownerId)}/icon`
          : null,
      };
    });
    return c.json({ skills, loadFailures });
  });

  return app;
}
