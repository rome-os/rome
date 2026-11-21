import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  computerUseConnectionSchema,
  type ComputerUseConnection,
  type ComputerUseStatus,
} from "@rome/api-types/computer-use";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { createLogger } from "../logger.js";

const log = createLogger("computer-use");
const CONNECTIONS_SETTING = "computerUse.connections";
const POLL_INTERVAL_MS = 5_000;
const CHECKPOINT_INTERVAL_MS = 10 * 60_000;
const daemonStatusSchema = z.object({
  ok: z.literal(true),
  daemonVersion: z.string().optional(),
  profiles: z.array(
    z.object({
      contextId: z.string().min(1),
      extensionConnected: z.boolean(),
      extensionVersion: z.string().optional(),
    }),
  ),
});
const aliasesSchema = z.object({ aliases: z.record(z.string(), z.string()) });

function serializeMetadata(connections: ComputerUseConnection[]): string {
  return JSON.stringify(
    connections.map(({ id, name, cli, status, version }) => ({ id, name, cli, status, version })),
  );
}

async function readAliases(): Promise<Record<string, string>> {
  try {
    const directory = process.env.OPENCLI_CONFIG_DIR || join(homedir(), ".opencli");
    const parsed = aliasesSchema.safeParse(
      JSON.parse(await readFile(join(directory, "browser-profiles.json"), "utf8")),
    );
    return parsed.success ? parsed.data.aliases : {};
  } catch {
    return {};
  }
}

interface Options {
  fetch?: typeof fetch;
  now?: () => number;
  readAliases?: () => Promise<Record<string, string>>;
}

export class ComputerUseService {
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly aliases: () => Promise<Record<string, string>>;
  private readonly connections = new Map<string, ComputerUseConnection>();
  private initialized = false;
  private inFlight: Promise<ComputerUseStatus> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private persisted = "";
  private persistedMetadata = "";
  private lastPersistedAt = 0;
  private stopped = false;

  constructor(
    private readonly settings: Pick<SettingsRepository, "get" | "set">,
    options: Options = {},
  ) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.aliases = options.readAliases ?? readAliases;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const poll = () => {
      void this.getStatus().catch((error: unknown) => {
        log.warn("Could not refresh browser connections", { error });
      });
    };
    poll();
    this.timer = setInterval(poll, POLL_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    // Reject new probes before awaiting the active one so its write finishes before the final flush.
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.inFlight?.catch(() => {});
    await this.persistConnections(this.snapshotConnections(), true).catch((error: unknown) => {
      log.warn("Could not save browser connections during shutdown", { error });
    });
  }

  getStatus(): Promise<ComputerUseStatus> {
    if (this.stopped) return Promise.reject(new Error("Computer use service is stopped"));
    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async refresh(): Promise<ComputerUseStatus> {
    if (!this.initialized) {
      const stored = z
        .array(computerUseConnectionSchema)
        .safeParse(await this.settings.get(CONNECTIONS_SETTING));
      if (stored.success) {
        for (const connection of stored.data) this.connections.set(connection.id, connection);
        this.persisted = JSON.stringify(stored.data);
        this.persistedMetadata = serializeMetadata(stored.data);
        this.lastPersistedAt = this.now();
      }
      this.initialized = true;
    }

    let daemon: ComputerUseStatus["daemon"] = { status: "unavailable", version: null };
    let profiles: z.infer<typeof daemonStatusSchema>["profiles"] = [];
    try {
      const response = await this.request("http://127.0.0.1:19825/status", {
        headers: { "X-OpenCLI": "1" },
        signal: AbortSignal.timeout(2_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error(`OpenCLI status returned HTTP ${response.status}`);
      const status = daemonStatusSchema.parse(await response.json());
      profiles = status.profiles;
      daemon = { status: "running", version: status.daemonVersion ?? null };
    } catch {
      // A failed probe cannot establish whether a browser itself is offline.
    }

    const checkedAt = new Date(this.now()).toISOString();
    const aliases = await this.aliases();
    for (const [id, connection] of this.connections) {
      this.connections.set(id, {
        ...connection,
        name: Object.keys(aliases).find((alias) => aliases[alias] === id) ?? connection.name,
        status: daemon.status === "running" ? "disconnected" : "unknown",
      });
    }
    for (const profile of profiles) {
      const previous = this.connections.get(profile.contextId);
      this.connections.set(profile.contextId, {
        id: profile.contextId,
        name:
          Object.keys(aliases).find((alias) => aliases[alias] === profile.contextId) ??
          previous?.name ??
          null,
        cli: "opencli",
        status: profile.extensionConnected ? "connected" : "disconnected",
        version: profile.extensionVersion ?? previous?.version ?? null,
        lastSeenAt: profile.extensionConnected ? checkedAt : (previous?.lastSeenAt ?? null),
      });
    }
    const connections = this.snapshotConnections();
    await this.persistConnections(connections);
    return { daemon, checkedAt, connections };
  }

  private snapshotConnections(): ComputerUseConnection[] {
    return [...this.connections.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  private async persistConnections(
    connections: ComputerUseConnection[],
    force = false,
  ): Promise<void> {
    const serialized = JSON.stringify(connections);
    if (serialized === this.persisted || connections.length === 0) return;
    const metadata = serializeMetadata(connections);
    const checkpointDue = this.now() - this.lastPersistedAt >= CHECKPOINT_INTERVAL_MS;
    if (!force && metadata === this.persistedMetadata && !checkpointDue) return;
    await this.settings.set(CONNECTIONS_SETTING, connections);
    this.persisted = serialized;
    this.persistedMetadata = metadata;
    this.lastPersistedAt = this.now();
  }
}
