import { describe, expect, it } from "@rstest/core";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { ResolvedApp } from "../apps/state.js";
import {
  RELAY_SETTING_KEY,
  buildRelayStatus,
  deriveDepositUrl,
  redactRelaySetting,
  relayDrainsEqual,
  resolveRelayDrains,
  resolveRelayTarget,
  sanitizeDrainUrl,
} from "./settings.js";
import type { RelayDrain, RelayDrainer } from "./drainer.js";

/** Minimal stubs: resolution reads only `settingsRepo.get` and `catalog.listResolved`. */
function settingsRepoReturning(value: unknown): SettingsRepository {
  return { get: async () => value } as unknown as SettingsRepository;
}

function app(appId: string, relayWebhook: string | null): ResolvedApp {
  return { appId, api: relayWebhook == null ? null : { relayWebhook } } as unknown as ResolvedApp;
}

function catalogWith(...apps: ResolvedApp[]): Pick<AppCatalog, "listResolved"> {
  return { listResolved: () => Object.freeze(apps) };
}

const CREDENTIAL = { drainUrl: "wss://relay.example/c/mb1", drainKey: "secret-key" };

describe("resolveRelayDrains", () => {
  it("binds the stored credential to the app that declares api.relayWebhook", async () => {
    const drains = await resolveRelayDrains(
      settingsRepoReturning(CREDENTIAL),
      catalogWith(app("notes", null), app("connector", "webhook")),
    );

    expect(drains).toEqual([
      {
        connectUrl: "wss://relay.example/c/mb1",
        drainKey: "secret-key",
        targetAppId: "connector",
        targetPath: ["webhook"],
      },
    ]);
  });

  it("delivers to a nested sub-path when the declaration has slashes", async () => {
    const drains = await resolveRelayDrains(
      settingsRepoReturning(CREDENTIAL),
      catalogWith(app("connector", "hooks/inbound")),
    );

    expect(drains[0]?.targetPath).toEqual(["hooks", "inbound"]);
  });

  it("returns no drains when the credential is present but no app consumes it", async () => {
    const drains = await resolveRelayDrains(
      settingsRepoReturning(CREDENTIAL),
      catalogWith(app("notes", null)),
    );

    expect(drains).toEqual([]);
  });

  it("returns no drains when the credential is absent", async () => {
    const drains = await resolveRelayDrains(
      settingsRepoReturning(undefined),
      catalogWith(app("connector", "webhook")),
    );

    expect(drains).toEqual([]);
  });

  it("treats a half-set credential as unconfigured", async () => {
    const drains = await resolveRelayDrains(
      settingsRepoReturning({ drainUrl: "wss://relay.example/c/mb1" }),
      catalogWith(app("connector", "webhook")),
    );

    expect(drains).toEqual([]);
  });
});

describe("resolveRelayTarget", () => {
  it("picks the first declaring app when more than one declares the capability", () => {
    const target = resolveRelayTarget(
      catalogWith(app("connector", "webhook"), app("stripe", "wh")),
    );
    expect(target).toEqual({ appId: "connector", path: ["webhook"] });
  });

  it("is null when no installed app declares the capability", () => {
    expect(resolveRelayTarget(catalogWith(app("notes", null)))).toBeNull();
  });
});

describe("relayDrainsEqual", () => {
  const base: RelayDrain = {
    connectUrl: "wss://relay.example/c/mb1",
    drainKey: "k",
    targetAppId: "connector",
    targetPath: ["webhook"],
  };

  it("is true for drains with the same connection and target", () => {
    expect(relayDrainsEqual([base], [{ ...base, targetPath: ["webhook"] }])).toBe(true);
  });

  it("treats two empty lists as equal (the unconfigured/no-consumer state)", () => {
    expect(relayDrainsEqual([], [])).toBe(true);
  });

  it("is false when the resolved target app changes (catalog hot-swap)", () => {
    expect(relayDrainsEqual([base], [{ ...base, targetAppId: "stripe" }])).toBe(false);
  });

  it("is false when the target path changes", () => {
    expect(relayDrainsEqual([base], [{ ...base, targetPath: ["hooks", "in"] }])).toBe(false);
  });

  it("is false when a consumer appears or disappears", () => {
    expect(relayDrainsEqual([], [base])).toBe(false);
    expect(relayDrainsEqual([base], [])).toBe(false);
  });
});

describe("deriveDepositUrl", () => {
  it("maps the wss drain face (/c/) to the https deposit face (/h/)", () => {
    expect(deriveDepositUrl("wss://relay.example/c/mb1")).toBe("https://relay.example/h/mb1");
  });

  it("maps a ws dev drain to http, preserving host:port", () => {
    expect(deriveDepositUrl("ws://127.0.0.1:8787/c/mb1")).toBe("http://127.0.0.1:8787/h/mb1");
  });

  it("drops any drain-side query so the deposit face carries no credential", () => {
    expect(deriveDepositUrl("wss://relay.example/c/mb1?t=secret")).toBe(
      "https://relay.example/h/mb1",
    );
  });

  it("throws on a drain URL whose path is not a /c/ mailbox face", () => {
    expect(() => deriveDepositUrl("wss://relay.example/h/mb1")).toThrow(/\/c\//);
  });
});

describe("buildRelayStatus", () => {
  it("surfaces the stored deposit URL alongside the resolved target", async () => {
    const status = await buildRelayStatus(
      settingsRepoReturning({ ...CREDENTIAL, depositUrl: "https://relay.example/h/mb1" }),
      undefined,
      catalogWith(app("connector", "webhook")),
    );

    expect(status.configured).toBe(true);
    expect(status.depositUrl).toBe("https://relay.example/h/mb1");
    expect(status.targetApp).toBe("connector");
  });

  it("reports a null deposit URL when the relay is unconfigured", async () => {
    const status = await buildRelayStatus(
      settingsRepoReturning(undefined),
      undefined,
      catalogWith(app("connector", "webhook")),
    );

    expect(status.configured).toBe(false);
    expect(status.depositUrl).toBeNull();
  });

  it("surfaces the live connection health from the drainer", async () => {
    const drainer = {
      getStatus: () => [
        {
          targetAppId: "connector",
          targetPath: ["webhook"],
          connected: true,
          lastTransportError: null,
          connectedSince: 1_000,
          nextReconnectAt: null,
          backlog: 4,
          lastEventAt: 2_000,
          deliveredCount: 7,
          retry: null,
          blocked: null,
          lastDeliveryFailure: { seq: 8, status: 503, error: null },
        },
      ],
    } as unknown as RelayDrainer;

    const status = await buildRelayStatus(
      settingsRepoReturning({ ...CREDENTIAL, depositUrl: "https://relay.example/h/mb1" }),
      drainer,
      catalogWith(app("connector", "webhook")),
    );

    expect(status.state).toBe("connected");
    expect(status.backlog).toBe(4);
    expect(status.nextAttemptAt).toBeNull();
    expect(status.failure).toMatchObject({ seq: 8, status: 503 });
  });

  it("maps a scheduled delivery retry to one state, deadline, and failure", async () => {
    const drainer = {
      getStatus: () => [
        {
          targetAppId: "connector",
          targetPath: ["webhook"],
          connected: true,
          lastTransportError: null,
          connectedSince: 1_000,
          nextReconnectAt: null,
          backlog: 1,
          lastEventAt: null,
          deliveredCount: 0,
          retry: { seq: 8, nextAttemptAt: 3_000 },
          blocked: null,
          lastDeliveryFailure: { seq: 8, status: 503, error: null },
        },
      ],
    } as unknown as RelayDrainer;

    const status = await buildRelayStatus(
      settingsRepoReturning(CREDENTIAL),
      drainer,
      catalogWith(app("connector", "webhook")),
    );

    expect(status).toMatchObject({
      state: "retrying",
      backlog: 1,
      nextAttemptAt: 3_000,
      failure: { seq: 8, status: 503 },
    });
  });

  it("reports idle connection health when no drainer is wired in", async () => {
    const status = await buildRelayStatus(
      settingsRepoReturning(undefined),
      undefined,
      catalogWith(app("connector", "webhook")),
    );

    expect(status.state).toBe("notConnected");
    expect(status.backlog).toBeNull();
    expect(status.nextAttemptAt).toBeNull();
    expect(status.failure).toBeNull();
  });
});

describe("sanitizeDrainUrl", () => {
  it("strips a credential-bearing ?t= query", () => {
    expect(sanitizeDrainUrl("wss://relay.example/c/mb1?t=secret")).toBe(
      "wss://relay.example/c/mb1",
    );
  });

  it("strips userinfo credentials", () => {
    expect(sanitizeDrainUrl("wss://user:pass@relay.example/c/mb1")).toBe(
      "wss://relay.example/c/mb1",
    );
  });

  it("leaves a bare URL unchanged (idempotent)", () => {
    expect(sanitizeDrainUrl("wss://relay.example/c/mb1")).toBe("wss://relay.example/c/mb1");
  });

  it("strips the entire query — unknown params cannot be assumed non-secret", () => {
    expect(sanitizeDrainUrl("wss://relay.example/c/mb1?other_token=secret2&t=secret")).toBe(
      "wss://relay.example/c/mb1",
    );
  });

  it("crude-strips the query of an unparseable value rather than throwing", () => {
    expect(sanitizeDrainUrl("not-a-url?t=secret")).toBe("not-a-url");
  });
});

describe("redactRelaySetting", () => {
  it("masks the drainKey and scrubs a credential embedded in the drain URL", () => {
    const redacted = redactRelaySetting({
      drainUrl: "wss://relay.example/c/mb1?t=secret",
      drainKey: "secret-key",
      depositUrl: "https://relay.example/h/mb1",
    }) as Record<string, string>;

    expect(redacted.drainKey).toBe("********");
    expect(redacted.drainUrl).toBe("wss://relay.example/c/mb1");
    expect(redacted.depositUrl).toBe("https://relay.example/h/mb1");
  });
});

// Guards against an accidental key rename desyncing the seed/read path.
it("reads the credential under the documented settings key", () => {
  expect(RELAY_SETTING_KEY).toBe("relay");
});

it("buildRelayStatus returns the drain URL with any embedded credential scrubbed", async () => {
  const status = await buildRelayStatus(
    settingsRepoReturning({
      drainUrl: "wss://relay.example/c/mb1?t=secret",
      drainKey: "secret-key",
      depositUrl: "https://relay.example/h/mb1",
    }),
    undefined,
    catalogWith(app("connector", "webhook")),
  );
  expect(status.drainUrl).toBe("wss://relay.example/c/mb1");
});
