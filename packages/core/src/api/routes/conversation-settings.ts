import { Hono } from "hono";
import type { ChatRef, ChatSettingField, PartialChatSettings } from "@rome-os/app-runtime";
import type { ApiDeps } from "../deps.js";

const dashboardActor = { kind: "guardian" as const, id: "dashboard" };

function parseRef(value: unknown): ChatRef {
  if (!value || typeof value !== "object") throw new Error("ref is required");
  const ref = value as { connectionId?: unknown; chatId?: unknown };
  if (typeof ref.connectionId !== "string" || !ref.connectionId) {
    throw new Error("ref.connectionId is required");
  }
  if (typeof ref.chatId !== "string") {
    throw new Error("ref.chatId is required");
  }
  return ref as ChatRef;
}

export function chatSettingsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/conversation-settings", async (c) => {
    const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
    const page = await deps.chatSettings.list({
      connectionId: c.req.query("connectionId"),
      query: c.req.query("query"),
      cursor: c.req.query("cursor"),
      limit: Number.isFinite(limit) ? limit : 50,
      availability: c.req.query("availability") as
        | "online"
        | "offline"
        | "not-connected"
        | undefined,
    });
    return c.json(page);
  });

  app.patch("/conversation-settings", async (c) => {
    try {
      const body = await c.req.json<{
        ref?: unknown;
        set?: PartialChatSettings;
        clear?: ChatSettingField[];
      }>();
      return c.json(
        await deps.chatSettings.update({
          ref: parseRef(body.ref),
          set: body.set ?? {},
          clear: Array.isArray(body.clear) ? body.clear : [],
          actor: dashboardActor,
        }),
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/conversation-settings/reset", async (c) => {
    try {
      const body = await c.req.json<{ ref?: unknown }>();
      return c.json(
        await deps.chatSettings.reset({ ref: parseRef(body.ref), actor: dashboardActor }),
      );
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  return app;
}
