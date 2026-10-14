import { ws } from "msw";
import {
  FILE_WATCH_SCOPES,
  FILE_WATCH_TOPIC_PREFIX,
  type FileWatchScope,
  fileWatchParamsSchema,
} from "@rome/api-types/live-events";

// Acknowledges every live-events subscription. File watch topics then carry
// the file-browser fixtures' own writes, like their `/events` streams. Every
// other topic stays silent, like the held-open SSE mocks: the fixtures change
// only through this mock's own mutations, which invalidate their queries
// directly.
const liveEvents = ws.link(/\/ws\/events$/);

type Send = (event: string, data: unknown) => void;
type FileWatchSource = (watch: string[], send: Send) => () => void;

const fileWatchSources = new Map<FileWatchScope, FileWatchSource>();

/** Serves `files.watch:<scope>:*` topics from a file-browser fixture. */
export function registerFileWatchSource(scope: FileWatchScope, source: FileWatchSource): void {
  fileWatchSources.set(scope, source);
}

function fileWatchSourceFor(topic: string): FileWatchSource | undefined {
  if (!topic.startsWith(FILE_WATCH_TOPIC_PREFIX)) return undefined;
  const scope = FILE_WATCH_SCOPES.find(
    (name) => name === topic.slice(FILE_WATCH_TOPIC_PREFIX.length).split(":")[0],
  );
  return scope ? fileWatchSources.get(scope) : undefined;
}

export const liveEventsHandlers = [
  liveEvents.addEventListener("connection", ({ client }) => {
    const releases = new Map<string, () => void>();
    client.addEventListener("message", (event) => {
      let message: { type?: unknown; topic?: unknown; params?: unknown };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const topic = message.topic;
      if (typeof topic !== "string") return;
      if (message.type === "unsubscribe") {
        releases.get(topic)?.();
        releases.delete(topic);
        return;
      }
      if (message.type !== "subscribe" || releases.has(topic)) return;
      client.send(JSON.stringify({ type: "subscribed", topic }));
      const source = fileWatchSourceFor(topic);
      const params = fileWatchParamsSchema.safeParse(message.params);
      if (!source || !params.success) {
        releases.set(topic, () => {});
        return;
      }
      releases.set(
        topic,
        source(params.data.watch, (name, data) =>
          client.send(JSON.stringify({ type: "event", topic, event: name, data })),
        ),
      );
    });
    client.addEventListener("close", () => {
      for (const release of releases.values()) release();
      releases.clear();
    });
  }),
];
