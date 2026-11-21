import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { test } from "node:test";
import { certSerial, makeCert } from "./make-cert.mjs";

test("a serial never starts with a zero byte or a set top bit", () => {
  for (const first of [0x00, 0x01, 0x7f, 0x80, 0xff]) {
    const serial = certSerial(Buffer.from([first, 0x01, 0x02]));
    assert.ok(serial[0] !== 0 && serial[0] < 0x80, `first byte ${first}`);
  }
  // Masking alone would leave 00 01 ..., which Node rejects as illegal padding.
  assert.equal(certSerial(Buffer.from([0x00, 0x01]))[0], 0x40);
});

test("generated certificates always parse", () => {
  for (let i = 0; i < 200; i++) {
    const { cert } = makeCert(["slack.com", "api.slack.com"]);
    const x509 = new X509Certificate(cert);
    assert.match(x509.subjectAltName ?? "", /slack\.com/);
  }
});

test("an IPv4 address is named as an address, so https://127.0.0.1 verifies", () => {
  const { cert } = makeCert(["slack.romeos.io", "127.0.0.1"]);
  const x509 = new X509Certificate(cert);
  assert.equal(x509.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(x509.checkHost("slack.romeos.io"), "slack.romeos.io");
  assert.match(x509.subjectAltName, /IP Address:127\.0\.0\.1/);
});
