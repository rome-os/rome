import { createHmac } from "node:crypto";
import { describe, expect, it } from "@rstest/core";
import {
  AliasConflictError,
  ComposioClient,
  disconnectManagedToolkit,
  isAliasConflict,
  reconcileManagedConnection,
  ROME_MANAGED_ALIAS,
  selectReusableAuthConfig,
  toEstablishedAccountSummaries,
  toManagedAccountSummaries,
  type ConnectAccountRow,
  type ConnectPort,
} from "./composio-client.js";

/** A connected-account row in the shape Composio's list endpoint returns. */
function accountRow(id: string, slug: string, status: string, alias: string | null = null) {
  return { id, toolkit: { slug }, status, alias };
}

describe("connected-account surfacing (toEstablishedAccountSummaries)", () => {
  // Repro: clicking Connect mints an INITIATED row before the guardian
  // authorizes. A denied/abandoned Gmail OAuth leaves that row behind — it must
  // not come back from the connectors list as a connection, or the dashboard
  // shows Gmail "connected" even though connecting failed.
  it("drops an abandoned connect attempt so a failed Gmail connect is not surfaced as connected", () => {
    const items = [accountRow("ca_1", "gmail", "INITIATED")];
    expect(toEstablishedAccountSummaries(items)).toEqual([]);
  });

  it("drops a half-started (INITIALIZING) connection", () => {
    expect(toEstablishedAccountSummaries([accountRow("ca_2", "gmail", "INITIALIZING")])).toEqual(
      [],
    );
  });

  it("drops a failed handshake (FAILED)", () => {
    expect(toEstablishedAccountSummaries([accountRow("ca_3", "gmail", "FAILED")])).toEqual([]);
  });

  it("surfaces an active connection, carrying its alias through", () => {
    expect(
      toEstablishedAccountSummaries([accountRow("ca_4", "gmail", "ACTIVE", ROME_MANAGED_ALIAS)]),
    ).toEqual([{ id: "ca_4", toolkitSlug: "gmail", status: "ACTIVE", alias: ROME_MANAGED_ALIAS }]);
  });

  it("surfaces an expired connection so it can show as needs-attention", () => {
    expect(toEstablishedAccountSummaries([accountRow("ca_5", "gmail", "EXPIRED")])).toEqual([
      { id: "ca_5", toolkitSlug: "gmail", status: "EXPIRED", alias: null },
    ]);
  });

  it("keeps only the established rows from a mixed list", () => {
    const items = [
      accountRow("ca_a", "gmail", "INITIATED"),
      accountRow("ca_b", "github", "ACTIVE"),
      accountRow("ca_c", "slack", "FAILED"),
      accountRow("ca_d", "googlecalendar", "EXPIRED"),
    ];
    expect(toEstablishedAccountSummaries(items).map((a) => a.id)).toEqual(["ca_b", "ca_d"]);
  });
});

describe("managed-only surfacing (toManagedAccountSummaries)", () => {
  // Rome owns exactly one connection per toolkit — the `ROME_MANAGED_ALIAS` row.
  // Accounts the guardian linked outside Rome (or legacy rows from before the
  // alias existed) must never reach the dashboard, even when ACTIVE, so the app
  // only ever shows and acts on what it manages.
  it("surfaces only the rome-managed account, hiding unmanaged active duplicates", () => {
    const items = [
      accountRow("ca_managed", "gmail", "ACTIVE", ROME_MANAGED_ALIAS),
      accountRow("ca_human", "gmail", "ACTIVE", null),
      accountRow("ca_human2", "gmail", "ACTIVE", "personal"),
    ];
    expect(toManagedAccountSummaries(items).map((a) => a.id)).toEqual(["ca_managed"]);
  });

  it("keeps a degraded managed account so it can show as needs-attention", () => {
    const items = [accountRow("ca_managed", "gmail", "EXPIRED", ROME_MANAGED_ALIAS)];
    expect(toManagedAccountSummaries(items)).toEqual([
      { id: "ca_managed", toolkitSlug: "gmail", status: "EXPIRED", alias: ROME_MANAGED_ALIAS },
    ]);
  });

  it("returns nothing when only unmanaged accounts exist", () => {
    const items = [
      accountRow("ca_human", "github", "ACTIVE", null),
      accountRow("ca_human2", "slack", "ACTIVE", "work"),
    ];
    expect(toManagedAccountSummaries(items)).toEqual([]);
  });
});

describe("auth config selection", () => {
  it("prefers an enabled Composio-managed config for a toolkit", () => {
    expect(
      selectReusableAuthConfig(
        [
          {
            id: "ac_custom",
            status: "ENABLED",
            toolkit: { slug: "supabase" },
            auth_scheme: "API_KEY",
          },
          {
            id: "ac_managed",
            status: "ENABLED",
            toolkit: { slug: "supabase" },
            is_composio_managed: true,
          },
        ],
        "SUPABASE",
      ),
    ).toBe("ac_managed");
  });

  it("reuses an enabled API-key config when no managed config exists", () => {
    expect(
      selectReusableAuthConfig(
        [
          {
            id: "ac_neon",
            status: "ENABLED",
            toolkit: { slug: "neon" },
            auth_scheme: "API_KEY",
          },
        ],
        "neon",
      ),
    ).toBe("ac_neon");
  });

  it("ignores disabled and wrong-toolkit auth configs", () => {
    expect(
      selectReusableAuthConfig(
        [
          {
            id: "ac_disabled",
            status: "DISABLED",
            toolkit: { slug: "neon" },
            auth_scheme: "API_KEY",
          },
          {
            id: "ac_other",
            status: "ENABLED",
            toolkit: { slug: "supabase" },
            is_composio_managed: true,
          },
        ],
        "neon",
      ),
    ).toBeNull();
  });
});

/**
 * In-memory stand-in for the three Composio operations the reconcile loop drives.
 * `list` reflects the current store, `delete` removes from it, and `createLink`
 * defaults to minting a fresh INITIALIZING managed row (what Composio does the
 * instant a link is issued). Tests override `createLink` to script races.
 */
function makePort(initial: ConnectAccountRow[] = []) {
  const rows = [...initial];
  const calls = { lists: 0, deleted: [] as string[], links: 0 };
  let linkImpl: ConnectPort["createLink"] = async () => {
    rows.push({ id: `ca_new_${rows.length}`, alias: ROME_MANAGED_ALIAS, status: "INITIALIZING" });
    return { redirectUrl: "https://auth.example/redirect" };
  };
  const port: ConnectPort = {
    listByToolkit: async () => {
      calls.lists++;
      return rows.map((r) => ({ ...r }));
    },
    deleteAccount: async (id) => {
      calls.deleted.push(id);
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
    createLink: async (input) => {
      calls.links++;
      return linkImpl(input);
    },
  };
  return { port, rows, calls, setLink: (f: ConnectPort["createLink"]) => (linkImpl = f) };
}

const PARAMS = {
  userId: "rome-guardian",
  toolkit: "gmail",
  authConfigId: "ac_1",
  callbackUrl: "https://app.example/callback",
};

describe("reconcileManagedConnection (connect dedup)", () => {
  it("reuses the existing ACTIVE managed connection instead of minting another", async () => {
    const { port, calls } = makePort([
      { id: "ca_live", alias: ROME_MANAGED_ALIAS, status: "ACTIVE" },
    ]);
    const out = await reconcileManagedConnection(port, PARAMS);
    expect(out).toEqual({ kind: "existing", id: "ca_live" });
    expect(calls.links).toBe(0); // no new connected account created
    expect(calls.deleted).toEqual([]);
  });

  it("mints a link when the guardian has no managed connection yet", async () => {
    const { port, calls } = makePort([]);
    const out = await reconcileManagedConnection(port, PARAMS);
    expect(out).toEqual({ kind: "redirect", url: "https://auth.example/redirect" });
    expect(calls.links).toBe(1);
  });

  it("deletes stuck pre-OAuth residue before re-linking, so dupes never accrue", async () => {
    const { port, calls } = makePort([
      { id: "ca_stuck", alias: ROME_MANAGED_ALIAS, status: "INITIALIZING" },
    ]);
    const out = await reconcileManagedConnection(port, PARAMS);
    expect(out.kind).toBe("redirect");
    expect(calls.deleted).toEqual(["ca_stuck"]); // squatting residue cleared
    expect(calls.links).toBe(1);
  });

  it("deletes a degraded (EXPIRED) managed account then re-links on reconnect", async () => {
    const { port, calls } = makePort([
      { id: "ca_old", alias: ROME_MANAGED_ALIAS, status: "EXPIRED" },
    ]);
    const out = await reconcileManagedConnection(port, PARAMS);
    expect(out.kind).toBe("redirect");
    expect(calls.deleted).toEqual(["ca_old"]);
  });

  it("never touches a connection owned by someone else (different alias)", async () => {
    const { port, calls } = makePort([{ id: "ca_human", alias: "personal", status: "ACTIVE" }]);
    const out = await reconcileManagedConnection(port, PARAMS);
    expect(out.kind).toBe("redirect"); // mints its own, ignores the human's
    expect(calls.deleted).toEqual([]);
  });

  it("loses an alias race, re-lists, and reuses the winner's account (OCC)", async () => {
    const { port, rows, calls, setLink } = makePort([]);
    setLink(async () => {
      // A competing connect won: its ACTIVE account now holds the alias.
      rows.push({ id: "ca_winner", alias: ROME_MANAGED_ALIAS, status: "ACTIVE" });
      throw new AliasConflictError();
    });
    const out = await reconcileManagedConnection(port, PARAMS);
    expect(out).toEqual({ kind: "existing", id: "ca_winner" });
    expect(calls.links).toBe(1); // one losing attempt, no duplicate minted
  });

  it("gives up loudly after the retry cap if the alias stays contended", async () => {
    const { port, calls, setLink } = makePort([]);
    setLink(async () => {
      throw new AliasConflictError();
    });
    await expect(reconcileManagedConnection(port, PARAMS)).rejects.toThrow(/contention/i);
    expect(calls.links).toBe(3);
  });
});

describe("disconnectManagedToolkit (teardown)", () => {
  const DISCONNECT_PARAMS = { userId: "rome-guardian", toolkit: "gmail" };

  it("deletes the managed connection so the toolkit returns to unconnected", async () => {
    const { port, calls } = makePort([
      { id: "ca_live", alias: ROME_MANAGED_ALIAS, status: "ACTIVE" },
    ]);
    const out = await disconnectManagedToolkit(port, DISCONNECT_PARAMS);
    expect(out).toEqual({ deleted: 1 });
    expect(calls.deleted).toEqual(["ca_live"]);
  });

  it("also removes a degraded (EXPIRED) managed row, leaving no half-connected residue", async () => {
    const { port, calls } = makePort([
      { id: "ca_old", alias: ROME_MANAGED_ALIAS, status: "EXPIRED" },
    ]);
    const out = await disconnectManagedToolkit(port, DISCONNECT_PARAMS);
    expect(out).toEqual({ deleted: 1 });
    expect(calls.deleted).toEqual(["ca_old"]);
  });

  it("never touches a connection the guardian linked outside Rome (different alias)", async () => {
    const { port, calls } = makePort([{ id: "ca_human", alias: "personal", status: "ACTIVE" }]);
    const out = await disconnectManagedToolkit(port, DISCONNECT_PARAMS);
    expect(out).toEqual({ deleted: 0 });
    expect(calls.deleted).toEqual([]);
  });

  it("reports nothing removed when the toolkit is already disconnected", async () => {
    const { port, calls } = makePort([]);
    const out = await disconnectManagedToolkit(port, DISCONNECT_PARAMS);
    expect(out).toEqual({ deleted: 0 });
    expect(calls.deleted).toEqual([]);
  });
});

describe("isAliasConflict", () => {
  it("recognizes the typed AliasConflictError", () => {
    expect(isAliasConflict(new AliasConflictError())).toBe(true);
  });
  it("recognizes a 409 status from the SDK", () => {
    expect(isAliasConflict({ status: 409 })).toBe(true);
  });
  it("recognizes conflict-ish wording about the alias", () => {
    expect(isAliasConflict(new Error("alias must be unique per entity and toolkit"))).toBe(true);
  });
  it("does not flag an unrelated error", () => {
    expect(isAliasConflict(new Error("network timeout"))).toBe(false);
  });
});

/**
 * Mirror Composio's Standard-Webhooks signing so the test independently proves
 * the verifier accepts genuine deliveries and rejects forged/stale ones — the
 * verify path is the only authentication on the public `/webhook` route.
 */
function sign(secret: string, id: string, timestamp: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(`${id}.${timestamp}.${payload}`, "utf8")
    .digest("base64");
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

const SECRET = "whsec_test_secret_value";
const ID = "msg_2abc";
const PAYLOAD = JSON.stringify({
  type: "composio.trigger.message",
  data: { triggerSlug: "GMAIL_NEW_GMAIL_MESSAGE" },
});

describe("ComposioClient.verifyWebhook", () => {
  it("accepts a correctly signed, fresh delivery and returns the parsed body", () => {
    const ts = nowSeconds();
    const result = ComposioClient.verifyWebhook({
      id: ID,
      payload: PAYLOAD,
      secret: SECRET,
      signature: `v1,${sign(SECRET, ID, ts, PAYLOAD)}`,
      timestamp: ts,
    });
    expect(result.rawPayload).toEqual(JSON.parse(PAYLOAD));
  });

  it("accepts when the header carries multiple space-separated v1 signatures", () => {
    const ts = nowSeconds();
    const result = ComposioClient.verifyWebhook({
      id: ID,
      payload: PAYLOAD,
      secret: SECRET,
      signature: `v1,not-the-one v1,${sign(SECRET, ID, ts, PAYLOAD)}`,
      timestamp: ts,
    });
    expect(result.rawPayload).toEqual(JSON.parse(PAYLOAD));
  });

  it("rejects a tampered payload", () => {
    const ts = nowSeconds();
    const sig = sign(SECRET, ID, ts, PAYLOAD);
    expect(() =>
      ComposioClient.verifyWebhook({
        id: ID,
        payload: `${PAYLOAD} `,
        secret: SECRET,
        signature: `v1,${sig}`,
        timestamp: ts,
      }),
    ).toThrow(/does not match/);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const ts = nowSeconds();
    expect(() =>
      ComposioClient.verifyWebhook({
        id: ID,
        payload: PAYLOAD,
        secret: SECRET,
        signature: `v1,${sign("whsec_a_different_secret", ID, ts, PAYLOAD)}`,
        timestamp: ts,
      }),
    ).toThrow(/does not match/);
  });

  it("rejects a delivery whose timestamp is outside the tolerance window", () => {
    const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);
    expect(() =>
      ComposioClient.verifyWebhook({
        id: ID,
        payload: PAYLOAD,
        secret: SECRET,
        signature: `v1,${sign(SECRET, ID, stale, PAYLOAD)}`,
        timestamp: stale,
      }),
    ).toThrow(/tolerance/);
  });

  it("rejects a header with no v1 signature", () => {
    const ts = nowSeconds();
    expect(() =>
      ComposioClient.verifyWebhook({
        id: ID,
        payload: PAYLOAD,
        secret: SECRET,
        signature: "v2,somethingelse",
        timestamp: ts,
      }),
    ).toThrow(/no v1 signature/);
  });
});
