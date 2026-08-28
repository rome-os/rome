import { describe, it, expect, rs } from "@rstest/core";
import { Hono } from "hono";
import { whatsappContactsRoutes } from "./whatsapp-contacts.js";
import type { ApiDeps } from "../deps.js";

type SendSpy = ReturnType<typeof rs.fn>;

function buildDeps(opts: { adapter?: SendSpy | null } = {}): {
  deps: ApiDeps;
  adapter: SendSpy | null;
} {
  const adapter = opts.adapter === undefined ? rs.fn(async () => undefined) : opts.adapter;
  const deps = {
    talkRouter: {
      list: async () =>
        adapter ? [{ connectionId: "connection:whatsapp", service: "whatsapp" }] : [],
      send: adapter ?? rs.fn(),
    },
    whatsAppStoreRepo: {
      listContacts: async () => [],
      getMessages: async () => [],
    },
  } as unknown as ApiDeps;
  return { deps, adapter };
}

function mount(deps: ApiDeps): Hono {
  return new Hono().route("/", whatsappContactsRoutes(deps));
}

const JID = "5551234@s.whatsapp.net";

async function post(app: Hono, body: unknown): Promise<Response> {
  return await app.request(`/whatsapp/contacts/${encodeURIComponent(JID)}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /whatsapp/contacts/:jid/send", () => {
  it("sends the text through the WhatsApp adapter keyed on the JID", async () => {
    const { deps, adapter } = buildDeps();
    const res = await post(mount(deps), { text: "  hello there  " });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // channelUserId is unused by the adapter, so the JID is passed for both args.
    expect(adapter).toHaveBeenCalledWith("connection:whatsapp", JID, {
      text: "hello there",
    });
  });

  it("rejects an empty message with 400 and never touches the adapter", async () => {
    const { deps, adapter } = buildDeps();
    const res = await post(mount(deps), { text: "   " });

    expect(res.status).toBe(400);
    expect(adapter).not.toHaveBeenCalled();
  });

  it("returns 503 when WhatsApp is not connected", async () => {
    const { deps } = buildDeps({ adapter: null });
    const res = await post(mount(deps), { text: "hi" });

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("not connected") });
  });

  it("surfaces a 502 when the adapter throws", async () => {
    const { deps } = buildDeps({
      adapter: rs.fn(async () => {
        throw new Error("socket closed");
      }),
    });
    const res = await post(mount(deps), { text: "hi" });

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "socket closed" });
  });
});
