import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { parse as parseYaml } from "yaml";
import { COMPOSIO_TRIGGERS, eventNameOf, WATCHABLES } from "./catalog.js";

interface EventSource {
  events: string;
  types?: string[];
  ensureAction: string;
}

const declaredSources = async (): Promise<EventSource[]> => {
  const path = fileURLToPath(new URL("../../app.yaml", import.meta.url));
  return (parseYaml(await readFile(path, "utf-8")) as { eventSources: EventSource[] }).eventSources;
};

describe("the watch catalog", () => {
  it("names only raw events this app declares under eventSources", async () => {
    const sources = await declaredSources();
    for (const watchable of WATCHABLES) {
      for (const kind of watchable.kinds) {
        for (const trigger of kind.triggers) {
          const eventName = eventNameOf(trigger);
          const declared = sources.find((source) => {
            if (!source.events.includes("*")) return source.events === eventName;
            const [prefix, suffix] = source.events.split("*") as [string, string];
            if (!eventName.startsWith(prefix) || !eventName.endsWith(suffix)) return false;
            return source.types?.includes(
              eventName.slice(prefix.length, eventName.length - suffix.length),
            );
          });
          expect({ kind: kind.kind, eventName, declared: Boolean(declared) }).toEqual({
            kind: kind.kind,
            eventName,
            declared: true,
          });
        }
      }
    }
  });

  it("declares Gmail's new mail alone, so other Gmail events stay undeclared", async () => {
    const gmail = (await declaredSources()).filter((s) => s.events.includes(":gmail."));
    expect(gmail).toEqual([
      {
        events: "provider:event:gmail.gmail_new_gmail_message",
        ensureAction: "connector_event_ensure",
      },
    ]);
  });

  it("declares exactly the Composio events each source's kinds listen on, each by name", async () => {
    const sources = await declaredSources();
    for (const watchable of WATCHABLES.filter((w) => w.source !== "github")) {
      const declared = sources.filter((s) => s.events.includes(`:${watchable.source}.`));
      const listened = watchable.kinds.flatMap((kind) => kind.triggers).map(eventNameOf);
      expect({ source: watchable.source, events: declared.map((s) => s.events).sort() }).toEqual({
        source: watchable.source,
        events: [...new Set(listened)].sort(),
      });
      for (const source of declared) {
        expect(source).toEqual({ events: source.events, ensureAction: "connector_event_ensure" });
      }
    }
  });

  it("gives every source's kinds and options unique names, and a default kind", () => {
    for (const watchable of WATCHABLES) {
      const kinds = watchable.kinds.map((k) => k.kind);
      expect(new Set(kinds).size).toBe(kinds.length);
      const options = watchable.options.map((o) => o.key);
      expect(new Set(options).size).toBe(options.length);
      expect(watchable.kinds.some((k) => k.default)).toBe(true);
    }
  });

  it("knows how to arm every Composio event a kind listens on", () => {
    for (const watchable of WATCHABLES.filter((w) => w.source !== "github")) {
      for (const trigger of watchable.kinds.flatMap((kind) => kind.triggers)) {
        const spec = COMPOSIO_TRIGGERS.get(eventNameOf(trigger));
        expect({ trigger, toolkit: spec?.toolkit }).toEqual({ trigger, toolkit: watchable.source });
      }
    }
  });
});
