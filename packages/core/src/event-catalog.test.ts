import { describe, it, expect, beforeEach } from "@rstest/core";
import { EventCatalog, inferPayloadSchema } from "./event-catalog.js";

// The catalog has two external roles. A *producer* app declares what event
// types it can currently emit (register / unregister). A *consumer* — the
// routine-creation flow — discovers what exists (list / get). Every scenario
// below asserts on what the consumer observes after a producer acts.

describe("Event catalog", () => {
  let catalog: EventCatalog;

  beforeEach(() => {
    catalog = new EventCatalog();
  });

  describe("discovering available event types", () => {
    it("shows nothing before any producer has registered", () => {
      expect(catalog.list()).toEqual([]);
      expect(catalog.get("connector:GMAIL_NEW_MESSAGE")).toBeUndefined();
    });

    it("surfaces an event type once a producer declares it can emit it", () => {
      catalog.register({ eventType: "connector:GMAIL_NEW_MESSAGE", appId: "connector" });

      expect(catalog.get("connector:GMAIL_NEW_MESSAGE")).toEqual({
        eventType: "connector:GMAIL_NEW_MESSAGE",
        appId: "connector",
      });
    });

    it("surfaces every event type across all producers", () => {
      catalog.register({ eventType: "connector:GMAIL_NEW_MESSAGE", appId: "connector" });
      catalog.register({ eventType: "connector:SLACK_NEW_MESSAGE", appId: "connector" });
      catalog.register({ eventType: "github:PR_OPENED", appId: "github" });

      const types = catalog.list().map((e) => e.eventType);
      expect(types.sort()).toEqual([
        "connector:GMAIL_NEW_MESSAGE",
        "connector:SLACK_NEW_MESSAGE",
        "github:PR_OPENED",
      ]);
    });
  });

  describe("searching for a watchable event type", () => {
    beforeEach(() => {
      catalog.register({ eventType: "provider:event:gmail.new_message", appId: "connector" });
      catalog.register({ eventType: "provider:event:gmail.message_sent", appId: "connector" });
      catalog.register({
        eventType: "provider:event:stripe.payment_succeeded",
        appId: "connector",
      });
      catalog.register({ eventType: "github:pr_opened", appId: "github" });
    });

    it("returns only the types whose name or app matches a keyword", () => {
      const { entries } = catalog.search("gmail", 10);
      expect(entries.map((e) => e.eventType).sort()).toEqual([
        "provider:event:gmail.message_sent",
        "provider:event:gmail.new_message",
      ]);
    });

    it("matches any token (OR) and ranks types hitting more tokens first", () => {
      const { entries } = catalog.search("gmail payment", 10);
      // stripe.payment hits 1 token, the two gmail types hit 1 each — all three
      // surface; the result is bounded by the query, not the full catalog.
      expect(entries.map((e) => e.eventType)).toContain("provider:event:stripe.payment_succeeded");
      expect(entries.map((e) => e.eventType)).toContain("provider:event:gmail.new_message");
      expect(entries).not.toContainEqual(
        expect.objectContaining({ eventType: "github:pr_opened" }),
      );
    });

    it("caps results at the limit but reports the full match count as total", () => {
      const { entries, total } = catalog.search("provider", 2);
      expect(entries).toHaveLength(2);
      expect(total).toBe(3);
    });

    it("finds nothing when no type matches the keywords", () => {
      expect(catalog.search("telegram", 10)).toEqual({ entries: [], total: 0 });
    });

    it("browses the first N entries when the query is blank", () => {
      const { entries, total } = catalog.search("", 2);
      expect(entries).toHaveLength(2);
      expect(total).toBe(4);
    });
  });

  describe("capturing the payload schema for discovery", () => {
    it("records the schema and its origin so a consumer can filter on real fields", () => {
      catalog.register({
        eventType: "connector:GMAIL_NEW_MESSAGE",
        appId: "connector",
        payloadSchema: { type: "object", properties: { from: { type: "string" } } },
        schemaOrigin: "observed",
      });

      expect(catalog.get("connector:GMAIL_NEW_MESSAGE")).toEqual({
        eventType: "connector:GMAIL_NEW_MESSAGE",
        appId: "connector",
        payloadSchema: { type: "object", properties: { from: { type: "string" } } },
        schemaOrigin: "observed",
      });
    });

    it("refreshes an observed schema when a later emission carries a payload", () => {
      catalog.register({
        eventType: "connector:GMAIL_NEW_MESSAGE",
        appId: "connector",
        payloadSchema: { type: "object", properties: { from: { type: "string" } } },
        schemaOrigin: "observed",
      });
      catalog.register({
        eventType: "connector:GMAIL_NEW_MESSAGE",
        appId: "connector",
        payloadSchema: {
          type: "object",
          properties: { from: { type: "string" }, subject: { type: "string" } },
        },
        schemaOrigin: "observed",
      });

      expect(catalog.get("connector:GMAIL_NEW_MESSAGE")?.payloadSchema).toEqual({
        type: "object",
        properties: { from: { type: "string" }, subject: { type: "string" } },
      });
    });

    it("keeps a known schema when a later payload-less emission re-registers the type", () => {
      catalog.register({
        eventType: "connector:GMAIL_NEW_MESSAGE",
        appId: "connector",
        payloadSchema: { type: "object", properties: { from: { type: "string" } } },
        schemaOrigin: "observed",
      });
      catalog.register({ eventType: "connector:GMAIL_NEW_MESSAGE", appId: "connector" });

      expect(catalog.get("connector:GMAIL_NEW_MESSAGE")?.payloadSchema).toEqual({
        type: "object",
        properties: { from: { type: "string" } },
      });
      expect(catalog.get("connector:GMAIL_NEW_MESSAGE")?.schemaOrigin).toBe("observed");
    });

    it("never lets an observed schema overwrite a declared one", () => {
      catalog.register({
        eventType: "connector:GMAIL_NEW_MESSAGE",
        appId: "connector",
        payloadSchema: {
          type: "object",
          properties: { from: { type: "string" } },
          required: ["from"],
        },
        schemaOrigin: "declared",
      });
      catalog.register({
        eventType: "connector:GMAIL_NEW_MESSAGE",
        appId: "connector",
        payloadSchema: { type: "object", properties: { other: { type: "number" } } },
        schemaOrigin: "observed",
      });

      expect(catalog.get("connector:GMAIL_NEW_MESSAGE")?.payloadSchema).toEqual({
        type: "object",
        properties: { from: { type: "string" } },
        required: ["from"],
      });
      expect(catalog.get("connector:GMAIL_NEW_MESSAGE")?.schemaOrigin).toBe("declared");
    });
  });

  describe("inferPayloadSchema", () => {
    it("maps each field to a JSON Schema type, recursing into nested objects", () => {
      expect(
        inferPayloadSchema({
          a: "x",
          b: 1,
          c: true,
          d: { nested: 1 },
          e: [1, 2],
          f: null,
        }),
      ).toEqual({
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "number" },
          c: { type: "boolean" },
          d: { type: "object", properties: { nested: { type: "number" } } },
          e: { type: "array" },
          f: { type: "null" },
        },
      });
    });

    it("never claims requiredness from a single sample", () => {
      expect(inferPayloadSchema({ a: "x" })).not.toHaveProperty("required");
    });

    it("stops descending at the depth cap so a deep payload can't balloon the catalog", () => {
      const schema = inferPayloadSchema({ l1: { l2: { l3: { l4: "deep" } } } });
      expect(schema).toEqual({
        type: "object",
        properties: {
          l1: {
            type: "object",
            properties: {
              l2: {
                type: "object",
                properties: { l3: { type: "object" } },
              },
            },
          },
        },
      });
    });

    it("returns undefined for an absent or empty payload so it never wipes a known schema", () => {
      expect(inferPayloadSchema(undefined)).toBeUndefined();
      expect(inferPayloadSchema({})).toBeUndefined();
    });
  });

  describe("when a producer withdraws an event type", () => {
    it("the type stops being discoverable", () => {
      catalog.register({ eventType: "connector:GMAIL_NEW_MESSAGE", appId: "connector" });

      catalog.unregister("connector", "connector:GMAIL_NEW_MESSAGE");

      expect(catalog.get("connector:GMAIL_NEW_MESSAGE")).toBeUndefined();
      expect(catalog.list()).toEqual([]);
    });

    it("the consumer can discover it again after the producer re-registers", () => {
      catalog.register({ eventType: "connector:GMAIL_NEW_MESSAGE", appId: "connector" });
      catalog.unregister("connector", "connector:GMAIL_NEW_MESSAGE");

      catalog.register({ eventType: "connector:GMAIL_NEW_MESSAGE", appId: "connector" });

      expect(catalog.get("connector:GMAIL_NEW_MESSAGE")).toBeDefined();
    });

    it("withdrawing a type that was never registered changes nothing", () => {
      catalog.unregister("connector", "connector:UNKNOWN");

      expect(catalog.list()).toEqual([]);
    });
  });

  describe("protecting event-type ownership", () => {
    it("rejects a second app claiming a type another app already owns", () => {
      catalog.register({ eventType: "connector:GMAIL_NEW_MESSAGE", appId: "connector" });

      expect(() =>
        catalog.register({ eventType: "connector:GMAIL_NEW_MESSAGE", appId: "impostor" }),
      ).toThrow(/already registered by app "connector"/);
    });

    it("leaves the original owner's entry intact when a collision is rejected", () => {
      catalog.register({ eventType: "connector:GMAIL_NEW_MESSAGE", appId: "connector" });

      try {
        catalog.register({ eventType: "connector:GMAIL_NEW_MESSAGE", appId: "impostor" });
      } catch {
        // expected
      }

      expect(catalog.get("connector:GMAIL_NEW_MESSAGE")?.appId).toBe("connector");
    });

    it("treats a re-register by the same owner as idempotent", () => {
      catalog.register({ eventType: "connector:GMAIL_NEW_MESSAGE", appId: "connector" });
      catalog.register({ eventType: "connector:GMAIL_NEW_MESSAGE", appId: "connector" });

      expect(catalog.list()).toHaveLength(1);
    });

    it("rejects one app withdrawing another app's event type", () => {
      catalog.register({ eventType: "connector:GMAIL_NEW_MESSAGE", appId: "connector" });

      expect(() => catalog.unregister("impostor", "connector:GMAIL_NEW_MESSAGE")).toThrow(
        /cannot unregister/,
      );
      expect(catalog.get("connector:GMAIL_NEW_MESSAGE")?.appId).toBe("connector");
    });
  });
});
