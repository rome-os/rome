import { createHash, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { isRecord } from "./actions.js";
import { isUuid } from "./frame.js";

export const signedComputerRequest = {
  type: "computer_use_request",
  protocol: "rome.computer-use.request.v1",
  algorithm: "ed25519",
} as const;

const lifetime = 15_000;
const maxClockLead = 2_000;
const maxBytes = 256 * 1024;

export function isComputerOperation(name: unknown): name is string {
  return typeof name === "string" && /^computer\.[a-z][a-z0-9_]{0,63}$/.test(name);
}

export interface ComputerRequest {
  peer: string;
  deviceId: string;
  epoch: string;
  requestId: string;
  action: string;
  args: unknown;
}

export interface ComputerAuthorization {
  requestId: string;
  authorization: string;
}

export function isComputerAuthorization(value: unknown): value is ComputerAuthorization {
  return (
    isRecord(value) &&
    isUuid(value.requestId) &&
    typeof value.authorization === "string" &&
    value.authorization.length <= 256
  );
}

// The v1 signature hashes JSON object keys in lexical order, including nested keys.
function argumentsHash(args: unknown): string {
  if (!isRecord(args)) throw new Error("Expected JSON object arguments.");
  let nodes = 0;
  let bytes = 0;
  const hash = createHash("sha256");
  function append(text: string) {
    bytes += Buffer.byteLength(text);
    if (bytes > maxBytes) throw new Error("Computer request too large.");
    hash.update(text);
  }
  function write(value: unknown, depth: number) {
    if (++nodes > 512 || depth > 12) throw new Error("Computer request too complex.");
    if (Array.isArray(value)) {
      append("[");
      for (let index = 0; index < value.length; index++) {
        if (index) append(",");
        write(value[index], depth + 1);
      }
      append("]");
    } else if (isRecord(value)) {
      append("{");
      for (const [index, key] of Object.keys(value).sort().entries()) {
        if (index) append(",");
        append(JSON.stringify(key));
        append(":");
        write(value[key], depth + 1);
      }
      append("}");
    } else if (
      value === null ||
      typeof value === "boolean" ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      append(JSON.stringify(value));
    } else throw new Error("Expected JSON arguments.");
  }
  write(args, 0);
  return hash.digest("hex");
}

function signingInput(request: ComputerRequest, issuedAt: number, expiresAt: number) {
  const { peer, deviceId, epoch, requestId, action, args } = request;
  if (
    ![peer, deviceId, epoch, requestId].every((id) => isUuid(id) && id === id.toLowerCase()) ||
    !isComputerOperation(action)
  )
    throw new Error("Invalid computer request.");
  return Buffer.from(
    JSON.stringify([
      signedComputerRequest.protocol,
      peer,
      deviceId,
      epoch,
      requestId,
      action,
      "json",
      argumentsHash(args),
      issuedAt,
      expiresAt,
    ]),
  );
}

export function signComputerRequest(
  key: KeyObject,
  request: Omit<ComputerRequest, "requestId">,
): ComputerAuthorization {
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519")
    throw new Error("Expected an Ed25519 private key.");
  const requestId = randomUUID();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + lifetime;
  const signature = sign(
    null,
    signingInput({ ...request, requestId }, issuedAt, expiresAt),
    key,
  ).toString("base64url");
  return {
    requestId,
    authorization: JSON.stringify({ version: 1, issuedAt, expiresAt, signature }),
  };
}

/** One verifier belongs to one target connection. Replacing it invalidates every outstanding request. */
export class ComputerRequestVerifier {
  readonly epoch = randomUUID();
  private readonly spent = new Map<string, number>();
  private clock = 0;

  constructor(
    private readonly deviceId: string,
    private readonly peer: string,
    private readonly publicKey: KeyObject,
  ) {
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519")
      throw new Error("Expected an Ed25519 public key.");
  }

  consume(
    request: Pick<ComputerRequest, "peer" | "requestId" | "action" | "args">,
    authorization: unknown,
  ): boolean {
    if (
      request.peer !== this.peer ||
      typeof authorization !== "string" ||
      authorization.length > 256
    )
      return false;
    try {
      const permit = JSON.parse(authorization);
      const { version, issuedAt, expiresAt, signature } = permit;
      this.clock = Math.max(this.clock, Date.now());
      if (
        version !== 1 ||
        !Number.isSafeInteger(issuedAt) ||
        !Number.isSafeInteger(expiresAt) ||
        issuedAt > this.clock + maxClockLead ||
        expiresAt <= issuedAt ||
        expiresAt <= this.clock ||
        expiresAt - issuedAt > lifetime ||
        typeof signature !== "string" ||
        !/^[A-Za-z0-9_-]{86}$/.test(signature)
      )
        return false;
      if (
        !verify(
          null,
          signingInput(
            { ...request, deviceId: this.deviceId, epoch: this.epoch },
            issuedAt,
            expiresAt,
          ),
          this.publicKey,
          Buffer.from(signature, "base64url"),
        )
      )
        return false;
      for (const [id, expires] of this.spent) if (expires <= this.clock) this.spent.delete(id);
      if (this.spent.size >= 4096 || this.spent.has(request.requestId)) return false;
      this.spent.set(request.requestId, expiresAt);
      return true;
    } catch {
      return false;
    }
  }
}

export { readBrowserStatus } from "./browser-status.js";
