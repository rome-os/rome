import { createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { actionError, isRecord, type ActionResponse } from "./actions.js";
import { readBrowserStatus } from "./browser-status.js";
import { ComputerRequestVerifier, signedComputerRequest } from "./computer-origin.js";
import { decodeMeta, encodeMeta, FRAME_TYPE, isUuid, type Frame } from "./frame.js";
import type { HostConnectionOptions, HostResponder } from "./host-connection.js";
import { runHostConnection } from "./host-connection.js";
import type { InboundEnvelope, OutboundEnvelope } from "./protocol.js";
import type { HostAudit } from "./executor.js";

const denied = actionError(
  "computer_origin_required",
  "This request has no verified computer controller.",
);
const unsupported = actionError(
  "unsupported_action",
  "This computer does not offer that operation.",
);

export function connectComputerHost(
  options: HostConnectionOptions & { grantFile: string; audit: HostAudit },
): Promise<void> {
  return runHostConnection(options, (session, send, sendFrame) =>
    createComputerResponder(session, options.grantFile, options.audit, send, sendFrame),
  );
}

export function createComputerResponder(
  session: { deviceId: string; cloudUrl: string; name: string },
  grantFile: string,
  audit: HostAudit,
  send: (reply: OutboundEnvelope) => boolean,
  sendFrame: (frame: Frame) => boolean,
): HostResponder {
  const loadGrant = async () => {
    const grant: unknown = JSON.parse(await readFile(grantFile, "utf8"));
    if (
      !isRecord(grant) ||
      grant.deviceId !== session.deviceId ||
      grant.cloudUrl !== session.cloudUrl ||
      !isUuid(grant.peer) ||
      typeof grant.publicKey !== "string" ||
      !grant.publicKey.startsWith("-----BEGIN PUBLIC KEY-----")
    )
      return null;
    return new ComputerRequestVerifier(
      session.deviceId,
      grant.peer,
      createPublicKey(grant.publicKey),
    );
  };
  let connection = loadGrant().catch(() => null);
  const running = new Set<Promise<void>>();
  async function receive(message: InboundEnvelope) {
    const current = connection;
    const verifier = await current;
    const request = message.payload;
    if (!isRecord(request) || typeof request.action !== "string" || current !== connection) return;
    const reply = (payload: ActionResponse) =>
      current === connection && send({ id: message.id, to: message.from, payload });
    if (request.type === "request" && request.action === "system.info") {
      const readiness = await audit.status();
      reply({
        type: "response",
        ok: true,
        result: {
          name: session.name,
          platform: process.platform === "darwin" ? "macos" : process.platform,
          actions: verifier ? ["system.info", "computer.status"] : ["system.info"],
          audit: { state: readiness.state },
          ...(verifier && {
            computerUsePilot: { epoch: verifier.epoch, signedRequest: signedComputerRequest },
          }),
        },
      });
      return;
    }
    if (
      !verifier ||
      request.type !== signedComputerRequest.type ||
      !verifier.consume(
        {
          peer: message.from,
          requestId: message.id,
          action: request.action,
          args: request.args,
        },
        request.authorization,
      )
    ) {
      reply(denied);
      return;
    }
    if (request.action !== "computer.status") {
      reply(unsupported);
      return;
    }
    const seq = await audit.start(
      request.action,
      { requestId: message.id, from: message.from },
      {},
      [],
    );
    if (seq === null) {
      reply(actionError("audit_unavailable", "The computer could not record this request."));
      return;
    }
    if (current !== connection) {
      audit.end(seq, request.action, "interrupted", {}, {}, []);
      return;
    }
    const browser = await readBrowserStatus().catch(() => null);
    audit.end(seq, request.action, current === connection ? "ok" : "interrupted", {}, {}, []);
    reply({
      type: "response",
      ok: true,
      result: {
        browser: browser
          ? {
              status: "running",
              connectedProfiles: browser.profiles.filter((p) => p.extensionConnected).length,
            }
          : { status: "unavailable" },
      },
    });
  }
  return {
    receive(message) {
      const work = receive(message);
      running.add(work);
      return work.finally(() => running.delete(work));
    },
    receiveFrame(frame) {
      if (frame.type === FRAME_TYPE.request && isRecord(decodeMeta(frame.meta)))
        sendFrame({
          type: FRAME_TYPE.response,
          peer: frame.peer,
          id: frame.id,
          meta: encodeMeta(denied),
          body: new Uint8Array(),
        });
    },
    disconnect() {
      connection = loadGrant().catch(() => null);
    },
    async idle() {
      await Promise.allSettled(running);
    },
  };
}
