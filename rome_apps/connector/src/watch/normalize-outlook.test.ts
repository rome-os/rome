import { describe, expect, it } from "@rstest/core";
import { normalizeOutlook } from "./normalize-outlook.js";

// The trigger payload as Composio's docs list it (`event_type`, `id`,
// `outlook_message`), and the message as Microsoft Graph returns it.
const address = "me@contoso.com";
const graph = (extra: Record<string, unknown> = {}) => ({
  id: "AAMk1",
  subject: "Quarterly numbers",
  bodyPreview: "Here are the numbers we talked about",
  from: { emailAddress: { name: "Ana Lima", address: "Ana@Fabrikam.com" } },
  toRecipients: [{ emailAddress: { name: "Me", address: "me@contoso.com" } }],
  ccRecipients: [],
  webLink: "https://outlook.office365.com/owa/?ItemID=AAMk1",
  inferenceClassification: "focused",
  importance: "normal",
  internetMessageHeaders: [{ name: "Message-ID", value: "<1@fabrikam.com>" }],
  ...extra,
});
const ctx = (
  read: (id: string) => Promise<Record<string, unknown>>,
  kinds = new Set(["new_mail"]),
) => ({
  address,
  kinds,
  reads: { outlookMessage: read },
});

describe("normalizeOutlook", () => {
  it("reads the message by its id and gives it in the common shape", async () => {
    const asked: string[] = [];
    const result = await normalizeOutlook(
      { event_type: "created", id: "AAMk1" },
      ctx(async (id) => {
        asked.push(id);
        return graph();
      }),
    );
    expect(asked).toEqual(["AAMk1"]);
    expect(result).toEqual({
      keep: true,
      event: {
        id: "outlook:me@contoso.com:AAMk1",
        source: "outlook",
        kind: "new_mail",
        actor: "Ana Lima <ana@fabrikam.com>",
        subject: "Quarterly numbers",
        url: "https://outlook.office365.com/owa/?ItemID=AAMk1",
        excerpt: "Here are the numbers we talked about",
        byYou: false,
        addressedTo: "direct",
        labels: [],
      },
    });
  });

  it("labels the Other tab, high importance, automated senders and mailing lists", async () => {
    const result = await normalizeOutlook(
      { id: "AAMk2" },
      ctx(async () =>
        graph({
          from: { emailAddress: { name: "Shop", address: "no-reply@shop.example" } },
          toRecipients: [],
          ccRecipients: [{ emailAddress: { address } }],
          inferenceClassification: "other",
          importance: "high",
          internetMessageHeaders: [
            { name: "List-Unsubscribe", value: "<mailto:u@shop.example>" },
            { name: "Precedence", value: "bulk" },
          ],
        }),
      ),
    );
    expect(result).toMatchObject({
      keep: true,
      event: {
        addressedTo: "copy",
        labels: ["not-focused", "high-importance", "automated", "mailing-list", "bulk"],
      },
    });
  });

  it("falls back to what the trigger supplied when the read fails, and fails with nothing to show", async () => {
    const failing = async () => {
      throw new Error("Outlook answered 503");
    };
    const supplied = await normalizeOutlook(
      { id: "AAMk3", outlook_message: graph({ subject: "From the trigger" }) },
      ctx(failing),
    );
    expect(supplied.keep && supplied.event.subject).toBe("From the trigger");
    await expect(normalizeOutlook({ id: "AAMk3" }, ctx(failing))).rejects.toThrow("503");
  });

  it("drops only a kind the follow has off or a payload with no id", async () => {
    const read = async () => graph();
    expect(await normalizeOutlook({ id: "AAMk1" }, ctx(read, new Set()))).toEqual({
      keep: false,
      reason: "not a kind this follow has on",
    });
    expect(await normalizeOutlook({}, ctx(read))).toEqual({ keep: false, reason: "no message id" });
  });
});
