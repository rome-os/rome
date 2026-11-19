import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./actions.js";
import { cloudOrigin } from "./cloud.js";
import { deviceSessionFromToken } from "./device-session.js";
import { isUuid } from "./frame.js";
import { runHostConnection, type HostCredential, type HostEvent } from "./host-connection.js";
import { createLanResponder } from "./lan-responder.js";
import { createFileCredentialStore } from "./storage.js";

interface LanNodeState {
  origin: string;
  installationId: string;
  verifier: string;
  usedGrant?: string;
  callerId?: string;
  host?: HostCredential;
}

class PairingRequired extends Error {}

async function redeem(
  origin: string,
  installationId: string,
  installToken: string,
  verifier: string,
  signal: AbortSignal,
) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const response = await fetch(new URL("/api/devices/lan-nodes/redeem", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${installToken}` },
      body: JSON.stringify({ installation_id: installationId, verifier }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    }).catch(() => null);
    if (response?.ok) {
      const data: unknown = await response.json().catch(() => null);
      const session = deviceSessionFromToken(data, origin);
      if (
        session &&
        isUuid(session.deviceId) &&
        isRecord(data) &&
        data.installation_id === installationId &&
        isUuid(data.caller_id)
      ) {
        signal.throwIfAborted();
        return { session, callerId: data.caller_id.toLowerCase() };
      }
    } else {
      await response?.body?.cancel().catch(() => {});
      if (response && [400, 401, 403, 409, 410].includes(response.status))
        throw new PairingRequired();
    }
    // A response can be lost after the issuer commits. Retry with the persisted verifier.
    await delay(Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)), undefined, { signal });
  }
}

export async function runLanNode(options: {
  cloudUrl: string;
  installationId: string;
  installToken?: string;
  stateDir: string;
  signal: AbortSignal;
  onEvent?(event: HostEvent): void;
}): Promise<"stopped" | "needs_pairing" | "superseded"> {
  const { installationId, installToken, signal } = options;
  const origin = cloudOrigin(options.cloudUrl);
  if (!isUuid(installationId)) throw new Error("Invalid LAN Node installation ID.");
  const store = createFileCredentialStore<LanNodeState>(join(options.stateDir, "state.json"));
  const existing = await store.load();
  if (
    existing !== null &&
    (!isRecord(existing) ||
      typeof existing.origin !== "string" ||
      existing.installationId !== installationId ||
      typeof existing.verifier !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(existing.verifier))
  ) {
    throw new Error("This volume belongs to a different LAN Node installation.");
  }
  const state = (existing as LanNodeState | null) ?? {
    origin,
    installationId,
    verifier: randomBytes(32).toString("base64url"),
  };
  if (!existing) await store.save(state);
  const grant =
    installToken && /^romeinstall_[A-Za-z0-9_-]{43}$/.test(installToken)
      ? { token: installToken, hash: createHash("sha256").update(installToken).digest("hex") }
      : null;
  const credentials = {
    // A fresh grant can pair through another address without sending the old device token there.
    load: async () => (state.origin === origin && isUuid(state.callerId) ? state.host : null),
    save: async (host: HostCredential) => {
      state.host = host;
      await store.save(state);
    },
    clear: async () => {
      delete state.host;
      await store.save(state);
    },
  };

  while (!signal.aborted) {
    const terminal = { revoked: false, superseded: false };
    try {
      await runHostConnection(
        {
          cloudUrl: origin,
          name: "LAN Node",
          signal,
          credentials,
          async authorize(_origin, _name, signal) {
            if (!grant || state.usedGrant === grant.hash) throw new PairingRequired();
            const { session, callerId } = await redeem(
              origin,
              installationId,
              grant.token,
              state.verifier,
              signal,
            );
            state.origin = origin;
            state.usedGrant = grant.hash;
            state.callerId = callerId;
            return session;
          },
          onEvent(event) {
            if (
              event.type === "connection" &&
              (event.status === "revoked" || event.status === "superseded")
            )
              terminal[event.status] = true;
            options.onEvent?.(event);
          },
        },
        (session, send, sendFrame) => {
          if (!isUuid(state.callerId)) throw new Error("Missing LAN Node caller identity.");
          return createLanResponder(session.name, state.callerId.toLowerCase(), send, sendFrame);
        },
      );
      return "stopped";
    } catch (error) {
      if (signal.aborted) return "stopped";
      if (error instanceof PairingRequired) return "needs_pairing";
      if (terminal.superseded) return "superseded";
      if (!terminal.revoked) throw error;
      await credentials.clear();
    }
  }
  return "stopped";
}
