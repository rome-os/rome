import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { parse as parseYaml } from "yaml";
import { eventNameOf, WATCHABLES } from "./catalog.js";

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
});
