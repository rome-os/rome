import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, expect, it, rs } from "@rstest/core";
import { ComputerRequestVerifier, signComputerRequest } from "./computer-origin.js";

afterEach(() => {
  rs.restoreAllMocks();
});

it("binds a single JSON request to the approved instance, target, connection, operation and arguments", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const peer = randomUUID();
  const deviceId = randomUUID();
  const target = new ComputerRequestVerifier(deviceId, peer, publicKey);
  const input = {
    peer,
    deviceId,
    epoch: target.epoch,
    action: "computer.status",
    args: { b: 2, a: ["read"] },
  };
  const proof = signComputerRequest(privateKey, input);
  const request = { ...input, requestId: proof.requestId };
  for (const change of [
    { peer: randomUUID() },
    { requestId: randomUUID() },
    { action: "computer.windows" },
    { args: { a: ["read"], b: 3 } },
  ]) {
    expect(target.consume({ ...request, ...change }, proof.authorization)).toBe(false);
  }
  for (const change of [{ deviceId: randomUUID() }, { epoch: randomUUID() }]) {
    const wrong = signComputerRequest(privateKey, { ...input, ...change });
    expect(target.consume({ ...request, requestId: wrong.requestId }, wrong.authorization)).toBe(
      false,
    );
  }
  const impostor = signComputerRequest(generateKeyPairSync("ed25519").privateKey, input);
  expect(
    target.consume({ ...request, requestId: impostor.requestId }, impostor.authorization),
  ).toBe(false);
  expect(target.consume({ ...request, args: { a: ["read"], b: 2 } }, proof.authorization)).toBe(
    true,
  );
  expect(target.consume(request, proof.authorization)).toBe(false);
  expect(
    new ComputerRequestVerifier(deviceId, peer, publicKey).consume(request, proof.authorization),
  ).toBe(false);
});

it("refuses expired signatures across a clock rollback", () => {
  const time = rs.spyOn(Date, "now").mockReturnValue(100_000);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const peer = randomUUID();
  const deviceId = randomUUID();
  const verifier = new ComputerRequestVerifier(deviceId, peer, publicKey);
  const input = { peer, deviceId, epoch: verifier.epoch, action: "computer.status", args: {} };
  const proof = signComputerRequest(privateKey, input);
  const request = { ...input, requestId: proof.requestId };
  time.mockReturnValue(115_000);
  expect(verifier.consume(request, proof.authorization)).toBe(false);
  time.mockReturnValue(100_001);
  expect(verifier.consume(request, proof.authorization)).toBe(false);
});
