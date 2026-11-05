import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";
import { parse as parseYaml } from "yaml";
import { ADAPTERS, adapterForEvent, adapterOf } from "./registry.js";
import { eventNameOf } from "./shared/event.js";

const WATCHABLES = ADAPTERS.map((adapter) => adapter.catalog);
/** Adapters whose events are each declared by exact name. */
const exact = ADAPTERS.filter((a) => !a.events.some((pattern) => pattern.endsWith("*")));

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
    for (const { catalog: watchable } of exact) {
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

  it("finds the adapter of every event a kind listens on, and of every source", () => {
    for (const watchable of WATCHABLES) {
      expect(adapterOf(watchable.source)?.catalog).toBe(watchable);
      for (const trigger of watchable.kinds.flatMap((kind) => kind.triggers)) {
        const source = adapterForEvent(eventNameOf(trigger))?.source;
        expect({ trigger, source }).toEqual({ trigger, source: watchable.source });
      }
    }
  });

  it("names each source once", () => {
    const sources = ADAPTERS.map((a) => a.source);
    expect(new Set(sources).size).toBe(sources.length);
  });
});

describe("dispatch through the registry", () => {
  const read = (path: string) => readFile(fileURLToPath(new URL(path, import.meta.url)), "utf-8");

  it("leaves the watch actions and the shared code naming no source", async () => {
    const files = [
      "../actions/connector-watch-sources/index.ts",
      "../actions/connector-watch-ensure/index.ts",
      "../actions/connector-watch-normalize/index.ts",
      "../actions/connector-watch-release/index.ts",
      "../actions/connector-event-ensure/index.ts",
      "./env.ts",
      "./registry.ts",
      "./types.ts",
      "./shared/composio.ts",
      "./shared/event.ts",
      "./shared/mail.ts",
      "./shared/status.ts",
      "./shared/text.ts",
    ];
    for (const file of files) {
      const code = (await read(file))
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
        .filter((line) => !/^import /.test(line))
        .join("\n");
      const named = ADAPTERS.map((a) => a.source).filter((source) => code.includes(`"${source}"`));
      expect({ file, named }).toEqual({ file, named: [] });
    }
  });
});
