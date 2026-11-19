import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./actions.js";
import { containerNodeOrigin } from "./container-node-address.js";
import { deviceSessionFromToken } from "./device-session.js";
import { isUuid } from "./frame.js";
import { runHostConnection, type HostCredential, type HostEvent } from "./host-connection.js";
import { createContainerNodeResponder } from "./container-node-responder.js";
import { createFileCredentialStore } from "./storage.js";

interface ContainerNodeState {
  origin: string;
  installationId: string;
  verifier: string;
  usedGrant?: string;
  callerId?: string;
  host?: HostCredential;
}

class PairingRequired extends Error {}

type ContainerNodeEvent = HostEvent | { type: "pairing_retry"; code: string };

async function redeem(
  origin: string,
  installationId: string,
  installToken: string,
  verifier: string,
  signal: AbortSignal,
  onEvent?: (event: ContainerNodeEvent) => void,
) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const response = await fetch(new URL("/api/devices/container-nodes/redeem", origin), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${installToken}` },
      body: JSON.stringify({ installation_id: installationId, verifier }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    }).catch((error: unknown) => {
      if (!signal.aborted) {
        const cause = error instanceof Error ? error.cause : undefined;
        const code = isRecord(cause) ? cause.code : undefined;
        onEvent?.({
          type: "pairing_retry",
          code:
            typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)
              ? code
              : "REQUEST_FAILED",
        });
      }
      return null;
    });
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
    } else if (response) {
      await response.body?.cancel().catch(() => {});
      if ([400, 401, 403, 409, 410].includes(response.status)) throw new PairingRequired();
      if (!signal.aborted) onEvent?.({ type: "pairing_retry", code: `HTTP_${response.status}` });
    }
    // A response can be lost after the issuer commits. Retry with the persisted verifier.
    await delay(Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)), undefined, { signal });
  }
}

export async function runContainerNode(options: {
  cloudUrl: string;
  installationId: string;
  installToken?: string;
  stateDir: string;
  signal: AbortSignal;
  onEvent?(event: ContainerNodeEvent): void;
}): Promise<"stopped" | "needs_pairing" | "superseded"> {
  const { installationId, installToken, signal } = options;
  const origin = containerNodeOrigin(options.cloudUrl);
  if (!isUuid(installationId)) throw new Error("Invalid container node installation ID.");
  const store = createFileCredentialStore<ContainerNodeState>(join(options.stateDir, "state.json"));
  const existing = await store.load();
  if (
    existing !== null &&
    (!isRecord(existing) ||
      typeof existing.origin !== "string" ||
      existing.installationId !== installationId ||
      typeof existing.verifier !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(existing.verifier))
  ) {
    throw new Error("This volume belongs to a different container node installation.");
  }
  const state = (existing as ContainerNodeState | null) ?? {
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
          name: "Container node",
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
              options.onEvent,
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
          if (!isUuid(state.callerId)) throw new Error("Missing container node caller identity.");
          return createContainerNodeResponder(
            session.name,
            state.callerId.toLowerCase(),
            send,
            sendFrame,
          );
        },
        origin.startsWith("http:"),
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
