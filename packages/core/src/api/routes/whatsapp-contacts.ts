import { Hono } from "hono";
import type { ConversationId } from "@rome-os/app-runtime";
import type { ApiDeps } from "../deps.js";

/**
 * Read-only views over the WhatsApp address-book mirror, backing the People
 * tab's "WhatsApp contacts" section. Promotion to a curated `persons` entry
 * goes through `POST /api/people` and `POST /api/people/:id/accounts` — a
 * contact's `jid` is the `channelUserId` those endpoints expect for WhatsApp.
 */
export function whatsappContactsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/whatsapp/contacts", async (c) => {
    const rows = await deps.whatsAppStoreRepo.listContacts();
    return c.json(rows);
  });

  app.get("/whatsapp/contacts/:jid/messages", async (c) => {
    const jid = c.req.param("jid");
    const limit = parsePositiveInt(c.req.query("limit"));
    const before = parsePositiveInt(c.req.query("before"));
    const messages = await deps.whatsAppStoreRepo.getMessages(jid, { limit, before });
    return c.json(messages);
  });

  // Send an outbound WhatsApp text straight from the People tab. The sent
  // message isn't persisted here — Baileys echoes it back via `messages.upsert`
  // (fromMe), which the adapter mirrors into `wa_messages`, so the chat view
  // converges on a normal refetch.
  app.post("/whatsapp/contacts/:jid/send", async (c) => {
    const jid = c.req.param("jid");
    const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown });
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return c.json({ error: "text is required" }, 400);
    }

    const whatsapp = (await deps.channelsService.list()).find(
      (channel) => channel.name === "whatsapp",
    );
    if (whatsapp?.connectionIds.length !== 1) {
      return c.json({ error: "WhatsApp is not connected" }, 503);
    }

    try {
      await deps.channelsService.send("whatsapp", jid as ConversationId, { text });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }

    return c.json({ ok: true });
  });

  return app;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
